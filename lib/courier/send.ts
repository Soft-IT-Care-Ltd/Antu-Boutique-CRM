import "server-only";

import type { DeliveryZone, Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import { STEADFAST_MAX_BULK, trackingUrlFromCode } from "@/lib/courier/constants";
import { estimateCourierCost, loadCostRates, orderWeightGrams } from "@/lib/courier/cost";
import { requireEnabledSteadfast } from "@/lib/courier/integration";
import * as steadfast from "@/lib/courier/steadfast/client";
import { buildSteadfastPayload, describeItems, type SteadfastSendableOrder } from "@/lib/courier/steadfast/payload";
import { DELIVERY_CHARGE_KEY, discoverTrackingUrl, findNumericField, normalizeSteadfastPhone } from "@/lib/courier/steadfast/status";
import { withTx, type Db } from "@/lib/db/tx";
import { moveOrderStatus } from "@/lib/orders/lifecycle";

// ============ Send to Steadfast (STEADFAST_INTEGRATION.md §2) ============
//
// PACKED orders only — stock was already deducted and cost frozen by the
// packing checklist, so booking a parcel never touches stock. Flow:
//   1. validate each order (status, one-person payload, phone, address)
//   2. CLAIM it: insert its shipments row with bookedAt = null. orderId is
//      unique, so a second concurrent Send can't claim the same order and
//      never reaches Steadfast — the double-send guard, enforced by the DB.
//   3. call Steadfast OUTSIDE any transaction: 1 order → create_order,
//      2–500 → bulk (chunked)
//   4. per order, in its own transaction: stamp the consignment on the
//      shipment, log the raw response, PACKED → HANDED_TO_COURIER with a
//      status-history note, audit log. A failed order releases its claim and
//      stays PACKED; partial success in a bulk send is fine.

/** A claim older than this with no consignment is from a crashed request and may be retaken. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

export type SendOverride = { orderId: string; zone?: DeliveryZone | null; weightGrams?: number | null };

export type SendPreviewRow = {
  orderId: string;
  orderNo: string;
  customerName: string;
  phone: string;
  normalizedPhone: string | null;
  address: string;
  deliveryNote: string | null;
  itemDescription: string;
  /** Stripped by the route for callers who can't see order money. */
  codAmount?: string;
  zone: DeliveryZone | null;
  weightGrams: number | null;
  weightComplete: boolean;
  /** Cost — stripped for roles without product.cost.view. */
  courierCostEstimate?: number | null;
  error: string | null;
};

export type SendResultRow = {
  orderId: string;
  orderNo: string;
  ok: boolean;
  /** Failed validation — never sent to Steadfast. */
  skipped?: boolean;
  consignmentId?: string;
  trackingCode?: string | null;
  error?: string;
};

const sendOrderInclude = {
  customer: { select: { name: true, phone: true, altPhone: true, addressDetail: true, thana: true, district: true } },
  courierZone: { select: { zone: true } },
  shipment: { select: { id: true, bookedAt: true, consignmentId: true, createdAt: true } },
  items: {
    select: {
      qty: true,
      returnedQty: true,
      variant: { select: { weightGrams: true, product: { select: { name: true } }, size: { select: { name: true } }, color: { select: { name: true } } } },
    },
  },
} satisfies Prisma.OrderInclude;

type SendOrder = Prisma.OrderGetPayload<{ include: typeof sendOrderInclude }>;

function toSendable(order: SendOrder): SteadfastSendableOrder {
  return {
    orderNo: order.orderNo,
    dueAmount: order.dueAmount,
    deliveryNote: order.deliveryNote,
    customer: order.customer,
    items: order.items.map((i) => ({
      qty: i.qty - i.returnedQty,
      productName: i.variant.product.name,
      sizeName: i.variant.size.name,
      colorName: i.variant.color.name,
    })),
  };
}

function isStaleClaim(shipment: SendOrder["shipment"], now = Date.now()): boolean {
  return Boolean(shipment && !shipment.bookedAt && now - shipment.createdAt.getTime() > STALE_CLAIM_MS);
}

/** Why this order can't be sent right now, or null. */
function sendBlocker(order: SendOrder): string | null {
  if (order.shipment?.bookedAt) {
    return order.shipment.consignmentId ? `Already sent to Steadfast (consignment ${order.shipment.consignmentId})` : "Already handed to a courier";
  }
  if (order.shipment && !isStaleClaim(order.shipment)) return "A Steadfast booking for this order is already in progress";
  if (order.status !== "PACKED") return `Order is ${order.status.replaceAll("_", " ").toLowerCase()} — only packed orders can be sent`;
  const built = buildSteadfastPayload(toSendable(order));
  return built.ok ? null : built.error;
}

async function loadOrders(db: Db, orderIds: string[], user: SessionUser): Promise<Map<string, SendOrder>> {
  const orders = await db.order.findMany({
    where: scopedWhere({ id: { in: orderIds }, deletedAt: null }, user) as Prisma.OrderWhereInput,
    include: sendOrderInclude,
  });
  return new Map(orders.map((o) => [o.id, o]));
}

function weightFor(order: SendOrder) {
  return orderWeightGrams(order.items.map((i) => ({ qty: i.qty - i.returnedQty, weightGrams: i.variant.weightGrams })));
}

/** The confirm dialog's rows: exactly what would be sent, with every blocker spelled out before anything is booked. */
export async function previewSteadfastSend(db: Db, orderIds: string[], user: SessionUser): Promise<SendPreviewRow[]> {
  const orders = await loadOrders(db, orderIds, user);
  const courier = await db.courierCompany.findUnique({ where: { provider: "STEADFAST" }, select: { id: true } });
  const rates = courier ? await loadCostRates(db, courier.id) : new Map();

  return orderIds.flatMap((orderId) => {
    const order = orders.get(orderId);
    if (!order) return [];
    const sendable = toSendable(order);
    const zone = order.courierZone?.zone ?? null;
    const weight = weightFor(order);
    return [
      {
        orderId: order.id,
        orderNo: order.orderNo,
        customerName: order.customer.name,
        phone: order.customer.phone,
        normalizedPhone: normalizeSteadfastPhone(order.customer.phone),
        address: [order.customer.addressDetail, order.customer.thana, order.customer.district].filter(Boolean).join(", "),
        deliveryNote: order.deliveryNote,
        itemDescription: describeItems(sendable.items),
        codAmount: Math.max(0, Number(order.dueAmount.toString())).toFixed(2),
        zone,
        weightGrams: weight.grams,
        weightComplete: weight.complete,
        courierCostEstimate: estimateCourierCost(zone ? rates.get(zone) : null, weight.grams),
        error: sendBlocker(order),
      },
    ];
  });
}

type Claimed = { order: SendOrder; payload: steadfast.CreateOrderPayload; shipmentId: string };
type Booked = { consignmentId?: string; trackingCode?: string | null; rawStatus?: string | null; raw?: unknown; error?: string };

export async function sendOrdersToSteadfast(
  db: Db,
  input: { orderIds: string[]; overrides?: SendOverride[] },
  actor: SessionUser,
): Promise<SendResultRow[]> {
  const { creds, courierId } = await requireEnabledSteadfast(db);
  const rates = await loadCostRates(db, courierId);
  const orderIds = [...new Set(input.orderIds)];
  const orders = await loadOrders(db, orderIds, actor);
  const overrides = new Map((input.overrides ?? []).map((o) => [o.orderId, o]));
  const results: SendResultRow[] = [];

  // ---- 1 + 2: validate and claim ----
  const claimed: Claimed[] = [];
  for (const orderId of orderIds) {
    const order = orders.get(orderId);
    if (!order) {
      results.push({ orderId, orderNo: orderId, ok: false, skipped: true, error: "Order not found" });
      continue;
    }
    const blocker = sendBlocker(order);
    if (blocker) {
      results.push({ orderId, orderNo: order.orderNo, ok: false, skipped: true, error: blocker });
      continue;
    }
    const built = buildSteadfastPayload(toSendable(order));
    if (!built.ok) continue; // unreachable: sendBlocker already ran it

    const override = overrides.get(orderId);
    const zone = override?.zone !== undefined ? override.zone : (order.courierZone?.zone ?? null);
    const weightGrams = override?.weightGrams !== undefined ? override.weightGrams : weightFor(order).grams;
    try {
      const shipmentId = await withTx(db, async (tx) => {
        if (order.shipment && isStaleClaim(order.shipment)) {
          await tx.shipment.deleteMany({ where: { id: order.shipment.id, bookedAt: null } });
        }
        const row = await tx.shipment.create({
          data: {
            orderId,
            courierId,
            zone,
            weightGrams,
            codAmount: built.payload.cod_amount,
            courierCostEstimate: estimateCourierCost(zone ? rates.get(zone) : null, weightGrams),
          },
          select: { id: true },
        });
        return row.id;
      });
      claimed.push({ order, payload: built.payload, shipmentId });
    } catch (err) {
      // P2002 on shipments.orderId: someone else claimed it a moment ago.
      const duplicate = (err as { code?: string }).code === "P2002";
      results.push({
        orderId,
        orderNo: order.orderNo,
        ok: false,
        skipped: true,
        error: duplicate ? "A Steadfast booking for this order is already in progress" : "Could not reserve the order for sending",
      });
    }
  }
  if (claimed.length === 0) return results;

  // ---- 3: book at Steadfast, outside any transaction ----
  const booked = new Map<string, Booked>();
  for (let i = 0; i < claimed.length; i += STEADFAST_MAX_BULK) {
    const chunk = claimed.slice(i, i + STEADFAST_MAX_BULK);
    if (chunk.length === 1) {
      const only = chunk[0];
      try {
        const { consignment, raw } = await steadfast.createOrder(creds, only.payload);
        booked.set(only.order.orderNo, {
          consignmentId: String(consignment.consignment_id),
          trackingCode: consignment.tracking_code ?? null,
          rawStatus: consignment.status ?? null,
          raw,
        });
      } catch (err) {
        booked.set(only.order.orderNo, { error: err instanceof Error ? err.message : "Steadfast create failed" });
      }
      continue;
    }
    try {
      const { items, raw } = await steadfast.createBulkOrder(
        creds,
        chunk.map((c) => c.payload),
      );
      const byInvoice = new Map(items.map((it) => [it.invoice, it]));
      const envelope = raw && typeof raw === "object" ? { status: (raw as { status?: unknown }).status } : {};
      for (const c of chunk) {
        const it = byInvoice.get(c.order.orderNo);
        if (it && it.status === "success" && it.consignment_id != null) {
          booked.set(c.order.orderNo, {
            consignmentId: String(it.consignment_id),
            trackingCode: it.tracking_code ?? null,
            rawStatus: null,
            raw: { bulk: true, item: it, ...envelope },
          });
        } else {
          booked.set(c.order.orderNo, { error: it?.note || (it ? `Steadfast rejected this order (${it.status})` : "Steadfast returned no result for this order") });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Steadfast bulk create failed";
      for (const c of chunk) booked.set(c.order.orderNo, { error: message });
    }
  }

  // ---- 4: record each success; release each failure ----
  for (const c of claimed) {
    const res = booked.get(c.order.orderNo);
    if (!res?.consignmentId) {
      await withTx(db, (tx) => tx.shipment.deleteMany({ where: { id: c.shipmentId, bookedAt: null } }));
      results.push({ orderId: c.order.id, orderNo: c.order.orderNo, ok: false, error: res?.error ?? "No consignment returned" });
      continue;
    }
    try {
      await withTx(db, (tx) => recordBooking(tx, c, res as Required<Pick<Booked, "consignmentId">> & Booked, actor.id, courierId));
      results.push({ orderId: c.order.id, orderNo: c.order.orderNo, ok: true, consignmentId: res.consignmentId, trackingCode: res.trackingCode ?? null });
    } catch (err) {
      // The parcel exists at Steadfast but we couldn't record it. Keep the
      // claim (so nobody re-sends it) and say exactly what to reconcile.
      results.push({
        orderId: c.order.id,
        orderNo: c.order.orderNo,
        ok: false,
        consignmentId: res.consignmentId,
        error: `Booked at Steadfast (consignment ${res.consignmentId}) but not recorded here: ${err instanceof Error ? err.message : "unknown error"} — check the order before sending again`,
      });
    }
  }

  return results;
}

async function recordBooking(
  tx: Prisma.TransactionClient,
  claim: Claimed,
  res: Booked & { consignmentId: string },
  actorId: string,
  steadfastCourierId: string,
): Promise<void> {
  // Re-read inside the transaction: the order may have been cancelled while
  // the courier call was in flight.
  const order = await tx.order.findUniqueOrThrow({ where: { id: claim.order.id }, select: { status: true, courierId: true } });
  if (order.status !== "PACKED") throw new Error(`order is now ${order.status}`);

  const deliveryCharge = findNumericField(res.raw, DELIVERY_CHARGE_KEY);
  const now = new Date();
  await tx.shipment.update({
    where: { id: claim.shipmentId },
    data: {
      consignmentId: res.consignmentId,
      trackingCode: res.trackingCode ?? null,
      trackingUrl: discoverTrackingUrl(res.raw) ?? trackingUrlFromCode(res.trackingCode),
      steadfastStatus: (res.rawStatus ?? "in_review").trim().toLowerCase(),
      bookedAt: now,
      bookedById: actorId,
      lastStatusAt: now,
      ...(deliveryCharge != null && deliveryCharge > 0 ? { courierCostActual: deliveryCharge } : {}),
    },
  });
  await tx.shipmentStatusLog.create({
    data: { shipmentId: claim.shipmentId, source: "API", rawStatus: res.rawStatus ?? null, rawPayload: (res.raw ?? {}) as Prisma.InputJsonValue },
  });

  // The order now travels with Steadfast whatever courier was picked on the
  // form. The customer's delivery charge on the order is untouched.
  if (order.courierId !== steadfastCourierId) {
    const zone = claim.order.courierZone?.zone;
    const steadfastZone = zone
      ? await tx.courierZone.findUnique({ where: { courierId_zone: { courierId: steadfastCourierId, zone } }, select: { id: true } })
      : null;
    await tx.order.update({ where: { id: claim.order.id }, data: { courierId: steadfastCourierId, courierZoneId: steadfastZone?.id ?? null } });
  }

  await moveOrderStatus(
    tx,
    { id: claim.order.id, status: "PACKED", items: [] },
    "HANDED_TO_COURIER",
    actorId,
    `Sent via Steadfast API, tracking ${res.trackingCode ?? res.consignmentId}`,
  );

  await writeAuditLogWith(tx, {
    actorId,
    action: "courier.steadfast.send",
    entityType: "order",
    entityId: claim.order.id,
    before: { status: "PACKED" },
    after: {
      status: "HANDED_TO_COURIER",
      consignmentId: res.consignmentId,
      trackingCode: res.trackingCode ?? null,
      payload: claim.payload,
    },
  });
}
