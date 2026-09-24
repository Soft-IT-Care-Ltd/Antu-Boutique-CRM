import "server-only";

import type { Prisma } from "@prisma/client";

import { mapSteadfastStatus, type MappedSteadfastStatus } from "@/lib/courier/steadfast/status";
import { isTransitionAllowed, moveOrderStatus } from "@/lib/orders/lifecycle";
import type { OrderStatusValue } from "@/lib/orders/constants";
import { postExchangeCourierCost } from "@/lib/returns/exchange-courier-cost";

// ============ Steadfast status → Antu (STEADFAST_INTEGRATION.md §3) ============
//
// The single place a courier status becomes an order status change. The
// webhook (source WEBHOOK) and the poller (source POLL) both call
// ingestSteadfastStatus inside a transaction, and it moves the order through
// the SAME moveOrderStatus every manual change uses — so status history and
// the RETURNED / PARTIAL_DELIVERED condition-check hooks fire identically.
//
// Idempotent: every payload is logged, but the order only moves when the
// target differs from where it already is. A replayed webhook adds no
// history row and never opens a second return inspection.

export type SyncSource = "WEBHOOK" | "POLL";

export const shipmentForSyncSelect = {
  id: true,
  consignmentId: true,
  codAmount: true,
  subStatus: true,
  steadfastStatus: true,
  finalizedAt: true,
  order: { select: { id: true, orderNo: true, status: true } },
} satisfies Prisma.ShipmentSelect;

export type ShipmentForSync = Prisma.ShipmentGetPayload<{ select: typeof shipmentForSyncSelect }>;

export type IngestResult = { mapped: MappedSteadfastStatus; transitioned: boolean; orderStatus: OrderStatusValue };

/** Log-only, for payloads whose consignment we couldn't match (or unknown notification types). */
export async function logUnmatchedPayload(tx: Prisma.TransactionClient, rawPayload: unknown, rawStatus: string | null, source: SyncSource) {
  await tx.shipmentStatusLog.create({
    data: { shipmentId: null, source, rawStatus, rawPayload: (rawPayload ?? {}) as Prisma.InputJsonValue },
  });
}

/**
 * The legal path from the order's status to the courier's target. The courier
 * can skip a stage we'd normally see (a missed "pending" webhook, or an order
 * someone put ON_HOLD) — route through IN_TRANSIT when that makes it legal,
 * so the status graph stays strict and history shows every step.
 */
function pathTo(from: OrderStatusValue, to: OrderStatusValue): OrderStatusValue[] | null {
  if (isTransitionAllowed(from, to)) return [to];
  if (to !== "IN_TRANSIT" && isTransitionAllowed(from, "IN_TRANSIT") && isTransitionAllowed("IN_TRANSIT", to)) return ["IN_TRANSIT", to];
  return null;
}

export async function ingestSteadfastStatus(
  tx: Prisma.TransactionClient,
  args: {
    shipment: ShipmentForSync;
    rawStatus: string;
    source: SyncSource;
    rawPayload: unknown;
    /** The courier's real charge for this parcel (webhook delivery_charge). */
    deliveryCharge?: number | null;
    /** COD the courier says it collected (webhook cod_amount on delivered/partial). */
    codCollected?: number | null;
    /** Set when the webhook's final status couldn't be confirmed (Round 2 §2.6). */
    attentionReason?: string | null;
  },
): Promise<IngestResult> {
  const { shipment, rawStatus, source } = args;
  const now = new Date();

  // 1. Audit trail — every status we receive, always.
  await tx.shipmentStatusLog.create({
    data: { shipmentId: shipment.id, source, rawStatus, rawPayload: (args.rawPayload ?? {}) as Prisma.InputJsonValue },
  });

  const mapped = mapSteadfastStatus(rawStatus);
  const from = shipment.order.status as OrderStatusValue;

  // Already final: the order may have moved on since (DELIVERED → COMPLETED),
  // so replays and late out-of-order statuses are logged and ignored. Only a
  // DIFFERENT final outcome (delivered, then cancelled) needs a human.
  if (shipment.finalizedAt) {
    const conflicting = mapped.final && mapped.normalized !== shipment.steadfastStatus;
    await tx.shipment.update({
      where: { id: shipment.id },
      data: {
        lastStatusAt: now,
        ...(source === "POLL" ? { lastPolledAt: now } : {}),
        ...(conflicting
          ? { needsAttention: true, attentionReason: `Steadfast now reports "${mapped.normalized}" after the parcel was already final as "${shipment.steadfastStatus}"` }
          : {}),
      },
    });
    return { mapped, transitioned: false, orderStatus: from };
  }

  let orderStatus = from;
  let transitioned = false;
  let attentionReason: string | null = args.attentionReason ?? null;

  // 2. Move the order, if the status calls for it and it isn't there yet.
  if (mapped.to && from !== mapped.to) {
    const path = pathTo(from, mapped.to);
    if (path) {
      for (const step of path) {
        await moveOrderStatus(tx, { id: shipment.order.id, status: orderStatus, items: [] }, step, null, `Steadfast ${source.toLowerCase()}: ${mapped.normalized}`);
        orderStatus = step;
      }
      transitioned = true;
    } else {
      // Understood, but illegal from here (e.g. a late "pending" after
      // DELIVERED). Never throw on courier data — surface it for a human.
      attentionReason = `Steadfast reported "${mapped.normalized}" but the order is already ${from.replaceAll("_", " ").toLowerCase()}`;
    }
  }
  if (!mapped.recognized) attentionReason ??= `Unrecognised Steadfast status "${mapped.raw}"`;
  else if (mapped.needsAttention) attentionReason ??= `Steadfast status "${mapped.normalized}" needs a manual check`;

  // 3. Shipment-side state.
  const data: Prisma.ShipmentUpdateInput = {
    steadfastStatus: mapped.normalized,
    onHold: mapped.onHold,
    needsAttention: attentionReason !== null,
    attentionReason,
    lastStatusAt: now,
  };
  if (source === "POLL") data.lastPolledAt = now;
  if (mapped.subStatus !== undefined) data.subStatus = mapped.subStatus;
  if (args.deliveryCharge != null && args.deliveryCharge > 0) data.courierCostActual = Math.round(args.deliveryCharge * 100) / 100;

  const reachedTarget = mapped.to !== null && orderStatus === mapped.to;
  if (transitioned && orderStatus === "IN_TRANSIT") data.inTransitAt = now;
  if (transitioned && (orderStatus === "DELIVERED" || orderStatus === "PARTIAL_DELIVERED")) {
    data.deliveredAt = now;
    // What the rider collected at the door. For a full delivery the poll
    // payload carries no amount, so it's the COD we asked for.
    data.codCollected = args.codCollected ?? (orderStatus === "DELIVERED" ? shipment.codAmount : null);
  }
  if (transitioned && orderStatus === "PARTIAL_DELIVERED") data.accountsReviewRequired = true;
  if (transitioned && orderStatus === "RETURNED") data.returnedAt = now;
  // Final at the courier AND reflected on the order → stop polling it.
  if (mapped.final && reachedTarget && !shipment.finalizedAt) data.finalizedAt = now;

  await tx.shipment.update({ where: { id: shipment.id }, data });
  // P3.2 — a company-borne exchange parcel's charge is final now: post it once.
  if (data.finalizedAt) await postExchangeCourierCost(tx, shipment.order.id, null);

  return { mapped, transitioned, orderStatus };
}

/** Steadfast `tracking_update`: a timeline entry, no status change. Deduplicated on (time, message) so replays don't repeat it. */
export async function ingestTrackingUpdate(
  tx: Prisma.TransactionClient,
  args: { shipmentId: string; message: string; eventAt: Date; source: SyncSource; rawPayload: unknown },
): Promise<{ created: boolean }> {
  await tx.shipmentStatusLog.create({
    data: { shipmentId: args.shipmentId, source: args.source, rawStatus: null, rawPayload: (args.rawPayload ?? {}) as Prisma.InputJsonValue },
  });
  const duplicate = await tx.shipmentTrackingEvent.findFirst({
    where: { shipmentId: args.shipmentId, eventAt: args.eventAt, message: args.message },
    select: { id: true },
  });
  if (duplicate) return { created: false };
  await tx.shipmentTrackingEvent.create({
    data: { shipmentId: args.shipmentId, message: args.message, eventAt: args.eventAt, source: args.source },
  });
  await tx.shipment.update({ where: { id: args.shipmentId }, data: { lastStatusAt: new Date() } });
  return { created: true };
}
