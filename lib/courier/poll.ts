import "server-only";

import { requireEnabledSteadfast } from "@/lib/courier/integration";
import * as steadfast from "@/lib/courier/steadfast/client";
import { ingestSteadfastStatus } from "@/lib/courier/sync";
import { lockShipmentForSync } from "@/lib/courier/webhook";
import { withTx, type Db } from "@/lib/db/tx";

// ============ Polling fallback (STEADFAST_INTEGRATION.md §3B) ============
//
// Webhooks get missed (server down, network). Every 15 minutes the cron asks
// the status API about each booked Steadfast shipment that is NOT final and
// hasn't heard from Steadfast (webhook or poll) within the polling interval
// — so the cron may fire more often than the interval without over-polling,
// and a shipment the webhook just updated is left alone. Final shipments
// (finalizedAt set: delivered / partial / cancelled after hub approval) are
// never polled again. The status API is authoritative, so a poll ingests its
// answer directly — including finalizing an order the webhook left waiting
// at *_approval_pending.
//
// One network call per shipment, OUTSIDE any transaction; each shipment's
// writes are their own small transaction, so one failure never rolls back
// the rest.

export type PollSummary = { ok: true; polled: number; changed: number; errors: { shipmentId: string; orderNo: string; error: string }[] };

const MAX_PER_RUN = 200;

export async function runSteadfastPoll(db: Db, opts: { shipmentId?: string; force?: boolean; delayMs?: number } = {}): Promise<PollSummary> {
  const { integration, creds, courierId } = await requireEnabledSteadfast(db);
  const cutoff = new Date(Date.now() - Math.max(1, integration.pollingMinutes) * 60_000);

  const shipments = await db.shipment.findMany({
    where: {
      courierId,
      consignmentId: { not: null },
      bookedAt: { not: null },
      finalizedAt: null,
      order: { status: { in: ["HANDED_TO_COURIER", "IN_TRANSIT", "ON_HOLD"] } },
      ...(opts.shipmentId ? { id: opts.shipmentId } : opts.force ? {} : { OR: [{ lastStatusAt: null }, { lastStatusAt: { lt: cutoff } }] }),
    },
    select: { id: true, consignmentId: true, order: { select: { orderNo: true } } },
    orderBy: { lastStatusAt: { sort: "asc", nulls: "first" } },
    take: MAX_PER_RUN,
  });

  const summary: PollSummary = { ok: true, polled: 0, changed: 0, errors: [] };
  const delayMs = opts.delayMs ?? 150;

  for (const s of shipments) {
    summary.polled += 1;
    try {
      let res: steadfast.StatusResult;
      try {
        res = await steadfast.statusByCid(creds, s.consignmentId!);
      } catch (err) {
        if (err instanceof steadfast.SteadfastLiveApiDisabledError) throw err;
        res = await steadfast.statusByInvoice(creds, s.order.orderNo);
      }
      if (!res.deliveryStatus) throw new Error("Steadfast returned no delivery_status");

      const changed = await withTx(db, async (tx) => {
        const shipment = await lockShipmentForSync(tx, s.id);
        if (!shipment) return false;
        const result = await ingestSteadfastStatus(tx, {
          shipment,
          rawStatus: res.deliveryStatus!,
          source: "POLL",
          rawPayload: { consignment_id: s.consignmentId, ...(res.raw && typeof res.raw === "object" ? (res.raw as Record<string, unknown>) : { delivery_status: res.deliveryStatus }) },
        });
        return result.transitioned;
      });
      if (changed) summary.changed += 1;
    } catch (err) {
      summary.errors.push({ shipmentId: s.id, orderNo: s.order.orderNo, error: err instanceof Error ? err.message : "poll failed" });
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  await db.courierIntegration.update({ where: { id: integration.id }, data: { lastSyncAt: new Date() } });
  return summary;
}
