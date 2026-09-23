import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { applyShipmentStatus } from "./courier";
import { getSystemUserId } from "./system-user";
import { ALLOWED_TRANSITIONS } from "./order-constants";
import {
  DELIVERY_CHARGE_KEY,
  WEIGHT_KEY,
  findNumericField,
  findRiderInfo,
  realRider,
  mapSteadfastStatus,
  trackingUrlFromCode,
  STEADFAST_COURIER_NAME,
  type MappedSteadfastStatus,
} from "./steadfast-constants";
import type { CourierStatusValue } from "./courier-constants";
import { requireEnabledSteadfast } from "./steadfast-integration";
import { statusByCid, statusByInvoice } from "./steadfast";
import { fetchPublicTracking } from "./steadfast-track";

// ============ Steadfast status sync (STEADFAST_INTEGRATION.md §3) ============
//
// The single place a Steadfast delivery status becomes a Gift Valy status change.
// Both the webhook (§3A, source=WEBHOOK) and the poller (§3B, source=POLL) call
// ingestDeliveryStatus, which routes ANY status transition through the SAME
// applyShipmentStatus used by manual courier updates — so order_status_history,
// the stock/return hooks and COD reconciliation fire identically to a hand entry.
//
// Idempotency (§3A step 5): every raw payload is logged, but a transition only
// happens when the target differs from the shipment's current status AND is a
// legal order transition. A duplicate/replayed webhook therefore adds no history
// row and never re-triggers the return flow.

export type Source = "WEBHOOK" | "POLL";

// The shape ingestDeliveryStatus needs — load the shipment with its order.
export interface ShipmentForSync {
  id: number;
  status: "HANDED_TO_COURIER" | "IN_TRANSIT" | "DELIVERED" | "RETURNED";
  courierStatus: CourierStatusValue | null; // §6m sub-state (never downgraded)
  riderName: string | null; // §R2 — a stored real rider is what makes ASSIGNED real
  order: { id: number; status: string; cancelReason: string | null };
}

export const shipmentForSyncInclude = {
  order: { select: { id: true, status: true, cancelReason: true } },
} satisfies Prisma.ShipmentInclude;

export interface IngestResult {
  matched: true;
  mapped: MappedSteadfastStatus;
  transitioned: boolean; // did the order/shipment status actually change
  to: string | null;
}

// Log-only helper for a payload whose consignment we don't recognize (§3A step 1).
export async function logUnmatchedStatus(
  tx: Prisma.TransactionClient,
  rawPayload: unknown,
  rawStatus: string | null,
  source: Source
) {
  await tx.shipmentStatusLog.create({
    data: {
      shipmentId: null,
      rawPayload: (rawPayload ?? {}) as Prisma.InputJsonValue,
      rawStatus,
      source,
    },
  });
}

export async function ingestDeliveryStatus(
  tx: Prisma.TransactionClient,
  args: {
    shipment: ShipmentForSync;
    rawStatus: string;
    source: Source;
    rawPayload: unknown;
    deliveryCharge?: number | null;
    weightKg?: number | null;
  }
): Promise<IngestResult> {
  const { shipment, rawStatus, source, rawPayload } = args;
  const systemUserId = await getSystemUserId(tx);

  // 1. Audit trail — every received status, always (§3A step 4 / §3B step 4).
  await tx.shipmentStatusLog.create({
    data: {
      shipmentId: shipment.id,
      rawPayload: (rawPayload ?? {}) as Prisma.InputJsonValue,
      rawStatus,
      source,
    },
  });

  // 2. Map (case-insensitive) and decide whether a status move is warranted.
  const mapped = mapSteadfastStatus(rawStatus);
  const target = mapped.to;
  const orderStatus = shipment.order.status as keyof typeof ALLOWED_TRANSITIONS;

  let transitioned = false;
  let flagUnexpected = false;
  if (target) {
    if (shipment.status === target) {
      // Already there — idempotent no-op (no duplicate history, no re-trigger).
    } else if (ALLOWED_TRANSITIONS[orderStatus]?.includes(target)) {
      await applyShipmentStatus(
        tx,
        shipment.id,
        {
          to: target,
          note: `Steadfast ${source.toLowerCase()}: ${rawStatus}`,
        },
        systemUserId
      );
      transitioned = true;
    } else {
      // A status we understand but that can't legally apply from here (e.g. a
      // late "pending" after DELIVERED) — surface for a human, never throw.
      flagUnexpected = true;
    }
  }

  // 3. Steadfast-specific fields + operator flags. applyShipmentStatus already
  // set status/delivered_at above; here we set the raw status, flags, poll stamp
  // and the real courier cost from the webhook's delivery_charge (§3A step 3).
  // The raw payload is ALSO mined for charge/weight fields the caller didn't
  // extract explicitly — the documented payloads don't promise them everywhere,
  // so any response that carries one is captured (CORRECTIONS Orders §6l).
  const deliveryCharge =
    args.deliveryCharge ?? findNumericField(rawPayload, DELIVERY_CHARGE_KEY);
  const weightKg = args.weightKg ?? findNumericField(rawPayload, WEIGHT_KEY);
  // §6m/§R2 — rider info from ANY payload that carries it (preferred over the
  // tracking-page scrape), but ONLY a REAL rider counts: a name AND a contact.
  // A bare name (hub/placeholder) is discarded so it never fakes an assignment.
  const rider = realRider(findRiderInfo(rawPayload));

  // §6m/§R2 sub-state: what the raw status implies, upgraded to ASSIGNED only
  // when a real rider is on record — either this payload carries one, or one was
  // already stored (a late/duplicate "pending" then never downgrades a genuine
  // ASSIGNED). ASSIGNED is thus never written without matching rider info, so the
  // warehouse-received state can no longer masquerade as Assigned.
  let courierStatus = mapped.courierStatus;
  if (
    courierStatus === "PENDING" &&
    (rider != null ||
      (shipment.courierStatus === "ASSIGNED" && shipment.riderName != null))
  ) {
    courierStatus = "ASSIGNED";
  }

  const data: Prisma.ShipmentUpdateInput = {
    steadfastStatus: mapped.normalized,
    onHold: mapped.onHold,
    needsAttention: mapped.needsAttention || flagUnexpected,
    updatedBy: systemUserId,
  };
  if (courierStatus != null) {
    data.courierStatus = courierStatus;
    // §R6 — reset the current-sub-status clock only when the sub-state actually
    // changes (a repeated "pending" poll keeps the clock running so a genuinely
    // stuck parcel keeps ageing).
    if (courierStatus !== shipment.courierStatus) {
      data.courierStatusAt = new Date();
    }
  }
  if (rider != null) {
    data.riderName = rider.name;
    data.riderPhone = rider.phone;
  }
  if (source === "POLL") data.lastPolledAt = new Date();
  if (deliveryCharge != null && deliveryCharge > 0) {
    data.courierCostActual = Math.round(deliveryCharge * 100) / 100;
  }
  if (weightKg != null && weightKg > 0) {
    // Anything above 100 can only be grams — gift parcels don't weigh 100+ kg.
    const kg = weightKg > 100 ? weightKg / 1000 : weightKg;
    data.steadfastWeightKg = Math.round(kg * 1000) / 1000;
  }
  await tx.shipment.update({ where: { id: shipment.id }, data });

  return { matched: true, mapped, transitioned, to: target };
}

// Tracking-only update (§3A payload 2) — no status change, just a timeline entry.
export async function ingestTrackingUpdate(
  tx: Prisma.TransactionClient,
  args: {
    shipmentId: number;
    message: string;
    eventAt: Date;
    source: Source;
  }
) {
  await tx.shipmentTrackingEvent.create({
    data: {
      shipmentId: args.shipmentId,
      message: args.message,
      eventAt: args.eventAt,
      source: args.source,
    },
  });
}

// ---------- polling fallback (§3B) + manual "Sync now" ----------

export interface PollSummary {
  polled: number;
  changed: number;
  trackingChecked: number; // public tracking-page fetches this run (§6l)
  errors: { shipmentId: number; error: string }[];
}

// The public tracking page is only consulted for shipments still missing data
// (the Steadfast weight, §6l — or the rider while In Transit, §6m), at most
// this often per shipment and this many per run — the "gentle" rule. Rider
// assignment moves within a delivery day, so its recheck window is shorter.
const TRACKING_CHECK_MIN_GAP_MS = 6 * 60 * 60 * 1000;
const RIDER_CHECK_MIN_GAP_MS = 2 * 60 * 60 * 1000;
const TRACKING_CHECKS_PER_RUN = 10;

// Reconcile non-final Steadfast shipments via the status API. Runs one network
// call per shipment OUTSIDE any transaction, then a small per-shipment
// transaction for the DB writes — so a single failure never rolls back the rest
// and no transaction is held open across the network (§5). Pass a shipmentId for
// the per-shipment refresh icon (ignores the interval + tracking-page cache);
// omit for the batch job.
//
// CORRECTIONS Orders §R1 — the order-list "Sync now" buttons scope a manual sync
// to one tab (`statuses`) and force it past the polling-interval gate (`force`),
// so clicking always refreshes every parcel currently in that tab right now. The
// tracking-page cache still applies (it stays gentle even under a manual sync).
export async function runSteadfastPoll(opts?: {
  shipmentId?: number;
  statuses?: ("HANDED_TO_COURIER" | "IN_TRANSIT")[];
  force?: boolean;
}): Promise<PollSummary> {
  const { integration, creds } = await requireEnabledSteadfast();
  const summary: PollSummary = {
    polled: 0,
    changed: 0,
    trackingChecked: 0,
    errors: [],
  };

  const courier = await prisma.courier.findUnique({
    where: { name: STEADFAST_COURIER_NAME },
    select: { id: true },
  });
  if (!courier) return summary;

  const intervalMs = Math.max(1, integration.pollingMinutes) * 60_000;
  const cutoff = new Date(Date.now() - intervalMs);

  const shipments = await prisma.shipment.findMany({
    where: {
      courierId: courier.id,
      consignmentId: { not: null },
      // Only non-final states (§3B step: stop once DELIVERED/RETURNED/PARTIAL);
      // a tab-scoped manual sync (§R1) narrows this to the requested tab.
      order: { status: { in: opts?.statuses ?? ["HANDED_TO_COURIER", "IN_TRANSIT"] } },
      ...(opts?.shipmentId
        ? { id: opts.shipmentId }
        : opts?.force
          ? // §R1 manual "Sync now": refresh every shipment in the tab now,
            // regardless of when it was last polled.
            {}
          : {
              AND: [
                { OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: cutoff } }] },
                // "Last webhook/poll update older than the interval" (§3B): every
                // webhook and poll writes a status log, so a log inside the window
                // means the shipment is fresh — skip it this round.
                { statusLogs: { none: { receivedAt: { gte: cutoff } } } },
              ],
            }),
    },
    select: {
      id: true,
      consignmentId: true,
      trackingNo: true,
      trackingUrl: true,
      order: { select: { orderNo: true } },
    },
  });

  for (const s of shipments) {
    summary.polled += 1;
    try {
      let raw: string | null = null;
      let rawResponse: unknown = null;
      try {
        const res = await statusByCid(creds, s.consignmentId!);
        raw = res.deliveryStatus;
        rawResponse = res.raw;
      } catch {
        // Fallback to invoice lookup per §3B step 2.
        const res = await statusByInvoice(creds, s.order.orderNo);
        raw = res.deliveryStatus;
        rawResponse = res.raw;
      }
      if (!raw) continue;

      const changed = await prisma.$transaction(async (tx) => {
        const shipment = await tx.shipment.findUnique({
          where: { id: s.id },
          include: shipmentForSyncInclude,
        });
        if (!shipment) return false;
        const res = await ingestDeliveryStatus(tx, {
          shipment: shipment as unknown as ShipmentForSync,
          rawStatus: raw!,
          source: "POLL",
          // The FULL status response — ingest mines it for charge/weight (§6l).
          rawPayload: {
            consignment_id: Number(s.consignmentId),
            ...(rawResponse && typeof rawResponse === "object"
              ? (rawResponse as Record<string, unknown>)
              : { delivery_status: raw }),
          },
        });
        return res.transitioned;
      });
      if (changed) summary.changed += 1;

      // §6l/§6m — PUBLIC tracking-page fallback for data the API doesn't carry:
      // the Steadfast weight, and the rider ("Assigned To") while the parcel is
      // In Transit without one. Post-ingest state decides, so a "pending" that
      // just moved the order in transit can pick its rider up on the same run.
      // Cached and capped so it stays gentle; a per-shipment refresh
      // (opts.shipmentId) bypasses the cache window.
      const fresh = await prisma.shipment.findUnique({
        where: { id: s.id },
        select: {
          steadfastWeightKg: true,
          courierCostActual: true,
          riderName: true,
          courierStatus: true,
          trackingPageCheckedAt: true,
          trackingUrl: true,
          order: { select: { status: true } },
        },
      });
      if (!fresh) continue;
      const trackingUrl =
        fresh.trackingUrl ?? s.trackingUrl ?? trackingUrlFromCode(s.trackingNo);
      const sinceCheck =
        fresh.trackingPageCheckedAt == null
          ? Infinity
          : Date.now() - fresh.trackingPageCheckedAt.getTime();
      const wantsWeight =
        fresh.steadfastWeightKg == null && sinceCheck >= TRACKING_CHECK_MIN_GAP_MS;
      // §R3 — chase the delivery charge from the tracking page too, on the same
      // gentle cadence, until we have it (the status API never carries it, so
      // without this the SF Charge column stays empty until a delivered webhook).
      const wantsCharge =
        fresh.courierCostActual == null && sinceCheck >= TRACKING_CHECK_MIN_GAP_MS;
      // Rider hunting only makes sense while the parcel is In Transit and no
      // rider is known yet (PENDING / legacy-null sub-state, §6m).
      const wantsRider =
        fresh.order.status === "IN_TRANSIT" &&
        fresh.riderName == null &&
        (fresh.courierStatus == null || fresh.courierStatus === "PENDING") &&
        sinceCheck >= RIDER_CHECK_MIN_GAP_MS;
      if (
        trackingUrl &&
        summary.trackingChecked < TRACKING_CHECKS_PER_RUN &&
        (opts?.shipmentId ? true : wantsWeight || wantsCharge || wantsRider)
      ) {
        summary.trackingChecked += 1;
        const info = await fetchPublicTracking(trackingUrl);
        // §6m/§R2 — a REAL rider on the page (name + phone, already enforced by
        // fetchPublicTracking) flips PENDING → ASSIGNED. Never overwrite rider
        // info a webhook/API payload already provided.
        const foundRider =
          info?.riderName != null &&
          info.riderPhone != null &&
          fresh.riderName == null;
        // §R3 — record the counted charge as the real courier cost, but never
        // clobber a value a webhook/API already set (that one is authoritative).
        const foundCharge =
          info?.deliveryCharge != null &&
          info.deliveryCharge > 0 &&
          fresh.courierCostActual == null;
        await prisma.shipment.update({
          where: { id: s.id },
          data: {
            trackingPageCheckedAt: new Date(),
            // Backfill the link for legacy shipments; prefer the canonical
            // public link when the page reports one.
            trackingUrl: info?.publicTrackingLink ?? trackingUrl,
            ...(info?.weightKg != null && info.weightKg > 0
              ? { steadfastWeightKg: info.weightKg }
              : {}),
            ...(foundCharge
              ? { courierCostActual: Math.round(info!.deliveryCharge! * 100) / 100 }
              : {}),
            ...(foundRider
              ? {
                  riderName: info!.riderName,
                  riderPhone: info!.riderPhone,
                  ...(fresh.courierStatus == null ||
                  fresh.courierStatus === "PENDING"
                    ? // §R6 — the sub-state flips to Assigned now, so reset the
                      // current-sub-status clock alongside it.
                      {
                        courierStatus: "ASSIGNED" as const,
                        courierStatusAt: new Date(),
                      }
                    : {}),
                }
              : {}),
          },
        });
      }

      // Rate-limit friendly: a small gap between calls (§5).
      await new Promise((r) => setTimeout(r, 150));
    } catch (e) {
      summary.errors.push({
        shipmentId: s.id,
        error: e instanceof Error ? e.message : "poll failed",
      });
    }
  }

  await prisma.courierIntegration.update({
    where: { id: integration.id },
    data: { lastSyncAt: new Date() },
  });

  return summary;
}
