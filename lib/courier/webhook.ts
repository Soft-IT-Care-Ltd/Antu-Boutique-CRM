import "server-only";

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { bearerFromHeader, credsFromIntegration, getSteadfastIntegration, verifyWebhookToken } from "@/lib/courier/integration";
import * as steadfast from "@/lib/courier/steadfast/client";
import { mapSteadfastStatus, parseSteadfastTimestamp, resolveFinalWebhookStatus } from "@/lib/courier/steadfast/status";
import { ingestSteadfastStatus, ingestTrackingUpdate, logUnmatchedPayload, shipmentForSyncSelect, type ShipmentForSync } from "@/lib/courier/sync";
import { withTx, type Db } from "@/lib/db/tx";

// ============ Inbound Steadfast webhook (STEADFAST_INTEGRATION.md §3A) ============
//
// Auth first: the Bearer token must match the one on the Courier page, or
// the request gets 401 before anything is read or written. Then:
//   delivery_status → ingestSteadfastStatus (a final status is cross-checked
//                     against the status API first — Round 2 §2.6)
//   tracking_update → a timeline entry (updated_at parsed as Dhaka — §2.5)
//   anything else   → logged, 200 (never crash on courier data)
// Idempotent end to end, so answering 500 on an unexpected error (Steadfast
// retries) is always safe.

export const WEBHOOK_OK = { status: "success", message: "Webhook received successfully." } as const;

const numeric = z.union([z.number(), z.string()]).nullish();

const webhookSchema = z
  .object({
    notification_type: z.string().trim().min(1).max(60),
    consignment_id: numeric,
    invoice: z.string().max(100).nullish(),
    status: z.string().max(100).nullish(),
    cod_amount: numeric,
    delivery_charge: numeric,
    tracking_message: z.string().max(2000).nullish(),
    updated_at: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

type WebhookPayload = z.infer<typeof webhookSchema>;

export type WebhookResponse = { status: number; body: Record<string, unknown> };

function toNumberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Row-locks the shipment, then reads it — so a webhook and a poll for the same parcel can't both move the order. */
export async function lockShipmentForSync(tx: Prisma.TransactionClient, shipmentId: string): Promise<ShipmentForSync | null> {
  await tx.$queryRaw`SELECT "id" FROM "shipments" WHERE "id" = ${shipmentId} FOR UPDATE`;
  return tx.shipment.findUnique({ where: { id: shipmentId }, select: shipmentForSyncSelect });
}

/** consignment_id first, then invoice = order no. (§3A step 1). Only booked Steadfast shipments match. */
async function findShipmentId(db: Db, payload: WebhookPayload): Promise<string | null> {
  const cid = payload.consignment_id == null ? "" : String(payload.consignment_id).trim();
  if (cid) {
    const byCid = await db.shipment.findUnique({ where: { consignmentId: cid }, select: { id: true } });
    if (byCid) return byCid.id;
  }
  const invoice = payload.invoice?.trim();
  if (invoice) {
    const byInvoice = await db.shipment.findFirst({ where: { order: { orderNo: invoice }, consignmentId: { not: null } }, select: { id: true } });
    if (byInvoice) return byInvoice.id;
  }
  return null;
}

export async function handleSteadfastWebhook(db: Db, authorization: string | null, rawBody: unknown): Promise<WebhookResponse> {
  const integration = await getSteadfastIntegration(db);
  if (!verifyWebhookToken(integration, bearerFromHeader(authorization))) {
    return { status: 401, body: { error: "Unauthorized" } };
  }

  const parsed = webhookSchema.safeParse(rawBody);
  if (!parsed.success) return { status: 400, body: { status: "error", message: "Invalid payload" } };
  const payload = parsed.data;

  await db.courierIntegration.update({ where: { id: integration!.id }, data: { lastWebhookAt: new Date() } });

  if (payload.notification_type === "delivery_status") {
    const shipmentId = await findShipmentId(db, payload);
    if (!shipmentId) {
      await withTx(db, (tx) => logUnmatchedPayload(tx, payload, payload.status ?? null, "WEBHOOK"));
      return { status: 200, body: { status: "error", message: "Invalid consignment ID." } };
    }

    const webhookStatus = payload.status ?? "";
    let effectiveStatus = webhookStatus;
    let attentionReason: string | null = null;
    let crossCheck: string | null = null;

    // Round 2 §2.6 — a final-looking webhook is only trusted once the status
    // API agrees. Network call before (never inside) the transaction.
    // Skipped for an already-final shipment: ingest ignores the replay anyway.
    const target = await db.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: { consignmentId: true, finalizedAt: true, order: { select: { orderNo: true } } },
    });
    if (mapSteadfastStatus(webhookStatus).final && !target.finalizedAt) {
      let apiStatus: string | null = null;
      let apiError: string | null = null;
      try {
        const creds = credsFromIntegration(integration);
        const res = target.consignmentId
          ? await steadfast.statusByCid(creds, target.consignmentId)
          : await steadfast.statusByInvoice(creds, target.order.orderNo);
        apiStatus = res.deliveryStatus;
        if (!apiStatus) apiError = "no status in the API response";
      } catch (err) {
        apiError = err instanceof Error ? err.message : "status API unavailable";
      }
      const resolved = resolveFinalWebhookStatus(webhookStatus, apiStatus, apiError);
      effectiveStatus = resolved.status;
      attentionReason = resolved.attentionReason;
      crossCheck = apiStatus ?? `unavailable: ${apiError}`;
    }

    await withTx(db, async (tx) => {
      const shipment = await lockShipmentForSync(tx, shipmentId);
      if (!shipment) return;
      await ingestSteadfastStatus(tx, {
        shipment,
        rawStatus: effectiveStatus,
        source: "WEBHOOK",
        // Logged verbatim, plus what the status API said when we asked it.
        rawPayload: crossCheck !== null ? { ...payload, status_api_cross_check: crossCheck, ingested_as: effectiveStatus } : payload,
        deliveryCharge: toNumberOrNull(payload.delivery_charge),
        codCollected: toNumberOrNull(payload.cod_amount),
        attentionReason,
      });
    });
    return { status: 200, body: { ...WEBHOOK_OK } };
  }

  if (payload.notification_type === "tracking_update") {
    const shipmentId = await findShipmentId(db, payload);
    if (!shipmentId) {
      await withTx(db, (tx) => logUnmatchedPayload(tx, payload, null, "WEBHOOK"));
      return { status: 200, body: { ...WEBHOOK_OK } };
    }
    // Round 2 §2.5 — updated_at is Asia/Dhaka local with no zone marker.
    const eventAt = parseSteadfastTimestamp(payload.updated_at) ?? new Date();
    await withTx(db, (tx) =>
      ingestTrackingUpdate(tx, {
        shipmentId,
        message: (payload.tracking_message ?? "").trim() || "(no message)",
        eventAt,
        source: "WEBHOOK",
        rawPayload: payload,
      }),
    );
    return { status: 200, body: { ...WEBHOOK_OK } };
  }

  await withTx(db, (tx) => logUnmatchedPayload(tx, payload, payload.status ?? null, "WEBHOOK"));
  return { status: 200, body: { ...WEBHOOK_OK } };
}
