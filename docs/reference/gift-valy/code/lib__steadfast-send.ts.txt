import type { CourierIntegration, Prisma } from "@prisma/client";
import { prisma } from "./db";
import { AuthzError } from "./authz";
import { applyHandover, autoPackForHandover } from "./courier";
import type { DeliveryZoneValue } from "./order-constants";
import {
  createOrder,
  createBulkOrder,
  type CreateOrderPayload,
  type SteadfastCreds,
} from "./steadfast";
import { credsFromIntegration } from "./steadfast-integration";
import {
  DELIVERY_CHARGE_KEY,
  WEIGHT_KEY,
  discoverTrackingUrl,
  findNumericField,
  normalizeBdPhone,
  trackingUrlFromCode,
  STEADFAST_COURIER_NAME,
} from "./steadfast-constants";

// ============ Send to Steadfast (STEADFAST_INTEGRATION.md §2) ============
//
// Validate CONFIRMED/PACKED orders, create them at Steadfast (single or bulk),
// and on success record the shipment through the EXISTING applyHandover — the
// same code a manual handover uses. So the order flips to HANDED_TO_COURIER
// with an order_status_history entry and shows up in the courier reports
// exactly as a hand entry does; we then stamp the Steadfast consignment id +
// status + tracking link onto the shipment. A CONFIRMED order is auto-PACKED
// FIRST, in its own transaction BEFORE any network call (CORRECTIONS Orders
// §6j) — stock deduction/cost snapshots fire identically to a manual pack, and
// a stock shortage blocks the send instead of stranding a booked consignment.
// Network calls happen outside any transaction; each order's handover is its
// own transaction, so partial success in a bulk send is fine (§2).

const MAX_BULK = 500; // §5: bulk create max 500/call.

export interface SendResultRow {
  orderId: number;
  orderNo: string;
  ok: boolean;
  skipped?: boolean; // failed pre-validation (never sent)
  trackingCode?: string;
  consignmentId?: number;
  error?: string;
}

// Per-order zone/weight from the send dialog (CORRECTIONS Courier §1) — both
// optional; applyHandover falls back to the order's zone and the BOM weight.
export interface SendOrderOverride {
  deliveryZone?: DeliveryZoneValue | null;
  weightKg?: number | null;
}

// The order fields the send flow needs.
const sendOrderSelect = {
  id: true,
  orderNo: true,
  status: true,
  cancelReason: true,
  recipientName: true,
  recipientPhoneBd: true,
  deliveryAddress: true,
  district: true,
  thana: true,
  deliveryDateMode: true,
  requestedDeliveryDate: true,
  courierNote: true,
  codAmount: true,
  customer: { select: { phoneForeign: true } },
  shipment: { select: { id: true, consignmentId: true } },
  items: {
    select: {
      qty: true,
      customName: true,
      product: { select: { name: true } },
      package: { select: { name: true } },
    },
  },
} as const;

type SendOrder = Awaited<
  ReturnType<
    typeof prisma.order.findMany<{ select: typeof sendOrderSelect }>
  >
>[number];

function buildPayload(o: SendOrder, phone: string): CreateOrderPayload {
  // District/Thana are "" on new orders (CORRECTIONS Orders §5) — the full
  // address is all Steadfast needs; legacy parts are appended when present.
  const address = [o.deliveryAddress, o.thana, o.district]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(", ")
    .slice(0, 250);
  // The consignment note = the COURIER NOTE (delivery instructions, §6d) plus
  // the fixed-date/ASAP timing hint (§1). Internal notes never leave the team.
  const noteParts: string[] = [];
  if (o.courierNote) noteParts.push(o.courierNote);
  if (o.deliveryDateMode === "FIXED" && o.requestedDeliveryDate) {
    noteParts.push(
      `Deliver ON ${o.requestedDeliveryDate.toISOString().slice(0, 10)} (fixed date)`
    );
  } else if (o.deliveryDateMode === "ASAP") {
    noteParts.push("Deliver ASAP");
  }
  const items = o.items
    .map((it) => {
      const name = it.product?.name ?? it.package?.name ?? it.customName ?? "Item";
      return `${name} ×${it.qty}`;
    })
    .join(", ")
    .slice(0, 250);

  const altPhone = normalizeBdPhone(o.customer.phoneForeign);
  const payload: CreateOrderPayload = {
    invoice: o.orderNo,
    recipient_name: o.recipientName.slice(0, 100),
    recipient_phone: phone,
    recipient_address: address,
    cod_amount: Math.max(0, Number(o.codAmount)),
    note: noteParts.join(" · ").slice(0, 200) || undefined,
    item_description: items || undefined,
    delivery_type: 0,
    total_lot: 1,
  };
  // alternative_phone ONLY if the customer's number is itself a valid 11-digit
  // BD number (§2 mapping) — the payer is usually abroad, so this is normally omitted.
  if (altPhone) payload.alternative_phone = altPhone;
  return payload;
}

// CORRECTIONS Orders §6j — an order sent from CONFIRMED is packed FIRST, in its
// own transaction, BEFORE the Steadfast call: stock/cost snapshots behave
// exactly like a manual pack, and a failure (short stock) surfaces as a skipped
// row instead of a consignment we then can't record. Returns an error message
// or null on success.
async function packBeforeSend(
  order: { id: number; status: string; cancelReason: string | null },
  userId: number
): Promise<string | null> {
  try {
    await prisma.$transaction((tx) => autoPackForHandover(tx, order, userId));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Could not auto-pack the order";
  }
}

// Stamp the Steadfast side of a freshly recorded shipment, inside the handover
// transaction: consignment id/status, the public tracking link (a link/token
// field discovered in the raw response wins, else built from tracking_code —
// CORRECTIONS Orders §6k/§6l), any charge/weight the response happens to carry,
// and the FULL raw API response into shipment_status_logs (source=API) so
// undocumented fields stay discoverable.
async function stampConsignment(
  tx: Prisma.TransactionClient,
  shipmentId: number,
  args: {
    consignmentId: number;
    trackingCode: string | null;
    rawStatus: string | null;
    rawResponse: unknown;
    userId: number;
  }
) {
  const trackingUrl =
    discoverTrackingUrl(args.rawResponse) ?? trackingUrlFromCode(args.trackingCode);
  const deliveryCharge = findNumericField(args.rawResponse, DELIVERY_CHARGE_KEY);
  const weight = findNumericField(args.rawResponse, WEIGHT_KEY);

  await tx.shipment.update({
    where: { id: shipmentId },
    data: {
      consignmentId: BigInt(args.consignmentId),
      steadfastStatus: (args.rawStatus ?? "in_review").toLowerCase(),
      trackingUrl,
      ...(deliveryCharge != null && deliveryCharge > 0
        ? { courierCostActual: Math.round(deliveryCharge * 100) / 100 }
        : {}),
      ...(weight != null && weight > 0
        ? { steadfastWeightKg: Math.round(weight * 1000) / 1000 }
        : {}),
      updatedBy: args.userId,
    },
  });
  await tx.shipmentStatusLog.create({
    data: {
      shipmentId,
      rawPayload: (args.rawResponse ?? {}) as Prisma.InputJsonValue,
      rawStatus: args.rawStatus,
      source: "API",
    },
  });
}

// ---------- consignment on shipment entry (manual handover form) ----------
//
// The shipments board's "Hand over" dialog with the Steadfast courier selected
// and no hand-typed tracking number books the consignment through the API and
// records the shipment with the returned tracking code — same payload rules,
// guards and handover transaction as the PACKED-tab bulk send above.

export interface HandoverConsignmentInput {
  orderId: number;
  courierId: number; // the Steadfast row in couriers — resolved by the route
  handoverDate: Date;
  codAmount: number;
  expectedDelivery: Date | null;
  note: string | null;
  // CORRECTIONS Courier §1 — zone + weight for the shipment's cost estimate.
  deliveryZone?: DeliveryZoneValue | null;
  weightKg?: number | null;
}

export interface HandoverConsignmentResult {
  shipmentId: number;
  consignmentId: number;
  trackingCode: string | null;
}

export async function createConsignmentForHandover(
  input: HandoverConsignmentInput,
  integration: CourierIntegration,
  userId: number
): Promise<HandoverConsignmentResult> {
  const creds: SteadfastCreds = credsFromIntegration(integration);

  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: sendOrderSelect,
  });
  if (!order) throw new AuthzError(404, "Order not found");
  if (order.shipment) {
    throw new AuthzError(
      400,
      order.shipment.consignmentId
        ? "This order was already sent to Steadfast"
        : "This order already has a shipment"
    );
  }
  if (order.status !== "PACKED" && order.status !== "CONFIRMED") {
    throw new AuthzError(
      400,
      `Only CONFIRMED or PACKED orders can be handed over — this order is ${order.status}`
    );
  }
  const phone = normalizeBdPhone(order.recipientPhoneBd);
  if (!phone) {
    throw new AuthzError(
      400,
      `Invalid recipient phone "${order.recipientPhoneBd}" — must be a 11-digit BD number`
    );
  }

  // §6j — pack a CONFIRMED order BEFORE the network call, so a stock shortage
  // blocks the booking instead of stranding it.
  if (order.status === "CONFIRMED") {
    const packError = await packBeforeSend(order, userId);
    if (packError) throw new AuthzError(400, packError);
  }

  // The form's COD amount is what Steadfast collects, so it overrides the
  // order's stored cod_amount in the payload.
  const payload = buildPayload(order, phone);
  payload.cod_amount = Math.max(0, Math.round(input.codAmount * 100) / 100);

  // Network call OUTSIDE the transaction (§5), then the same handover + stamp
  // transaction the bulk send uses.
  const { consignment, raw } = await createOrder(creds, payload);

  const apiNote = `Sent via Steadfast API, tracking ${
    consignment.tracking_code ?? consignment.consignment_id
  }`;
  try {
    const shipmentId = await prisma.$transaction(async (tx) => {
      const shipment = await applyHandover(
        tx,
        {
          orderId: input.orderId,
          courierId: input.courierId,
          trackingNo: consignment.tracking_code ?? null,
          handoverDate: input.handoverDate,
          codAmount: input.codAmount,
          expectedDelivery: input.expectedDelivery,
          note: input.note ? `${input.note} · ${apiNote}` : apiNote,
          deliveryZone: input.deliveryZone,
          weightKg: input.weightKg,
        },
        userId
      );
      await stampConsignment(tx, shipment.id, {
        consignmentId: Number(consignment.consignment_id),
        trackingCode: consignment.tracking_code ?? null,
        rawStatus: consignment.status ?? null,
        rawResponse: raw,
        userId,
      });
      return shipment.id;
    });
    return {
      shipmentId,
      consignmentId: Number(consignment.consignment_id),
      trackingCode: consignment.tracking_code ?? null,
    };
  } catch (e) {
    // The consignment exists at Steadfast but recording failed — surface it so
    // the operator reconciles instead of double-booking (§2 error rule).
    throw new AuthzError(
      500,
      `Created at Steadfast (consignment ${consignment.consignment_id}) but failed to record locally: ${
        e instanceof Error ? e.message : "unknown error"
      }`
    );
  }
}

export async function sendOrdersToSteadfast(
  orderIds: number[],
  integration: CourierIntegration,
  userId: number,
  overrides: Record<number, SendOrderOverride> = {}
): Promise<SendResultRow[]> {
  const creds: SteadfastCreds = credsFromIntegration(integration);
  const results: SendResultRow[] = [];

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: sendOrderSelect,
  });
  const byId = new Map(orders.map((o) => [o.id, o]));

  // Resolve (or create) the Steadfast courier row once — applyHandover attaches
  // the shipment to it, so the manual courier reports treat these like any other.
  const courier = await prisma.courier.upsert({
    where: { name: STEADFAST_COURIER_NAME },
    update: {},
    create: { name: STEADFAST_COURIER_NAME, isActive: true, createdBy: userId },
    select: { id: true },
  });

  // ---- 1. pre-validate; collect sendable payloads (§2 guards). CONFIRMED
  // orders auto-pack HERE, before any network call (§6j) — a pack failure
  // (short stock) skips the row, so nothing unrecordable gets booked. ----
  const toSend: { order: SendOrder; payload: CreateOrderPayload }[] = [];
  for (const orderId of orderIds) {
    const o = byId.get(orderId);
    if (!o) {
      results.push({ orderId, orderNo: String(orderId), ok: false, skipped: true, error: "Order not found" });
      continue;
    }
    if (o.shipment) {
      // Never double-send (§2 guard): an existing shipment means it's already gone.
      results.push({
        orderId,
        orderNo: o.orderNo,
        ok: false,
        skipped: true,
        error: o.shipment.consignmentId
          ? "Already sent to Steadfast"
          : "Already handed to a courier",
      });
      continue;
    }
    if (o.status !== "PACKED" && o.status !== "CONFIRMED") {
      results.push({
        orderId,
        orderNo: o.orderNo,
        ok: false,
        skipped: true,
        error: `Order is ${o.status}, not CONFIRMED or PACKED`,
      });
      continue;
    }
    const phone = normalizeBdPhone(o.recipientPhoneBd);
    if (!phone) {
      results.push({
        orderId,
        orderNo: o.orderNo,
        ok: false,
        skipped: true,
        error: `Invalid recipient phone "${o.recipientPhoneBd}" — must be a 11-digit BD number`,
      });
      continue;
    }
    if (o.status === "CONFIRMED") {
      const packError = await packBeforeSend(o, userId);
      if (packError) {
        results.push({
          orderId,
          orderNo: o.orderNo,
          ok: false,
          skipped: true,
          error: packError,
        });
        continue;
      }
    }
    toSend.push({ order: o, payload: buildPayload(o, phone) });
  }

  if (toSend.length === 0) return results;

  // ---- 2. create at Steadfast (single or bulk, chunked at 500) ----
  // invoice → { consignmentId, trackingCode, rawStatus, raw, error }. The raw
  // API response rides along so the record step can log it in full and mine it
  // for tracking-link/charge/weight fields (CORRECTIONS Orders §6l).
  const created = new Map<
    string,
    {
      consignmentId?: number;
      trackingCode?: string;
      rawStatus?: string | null;
      raw?: unknown;
      error?: string;
    }
  >();

  for (let i = 0; i < toSend.length; i += MAX_BULK) {
    const chunk = toSend.slice(i, i + MAX_BULK);
    if (chunk.length === 1) {
      const only = chunk[0];
      try {
        const { consignment: c, raw } = await createOrder(creds, only.payload);
        created.set(only.order.orderNo, {
          consignmentId: Number(c.consignment_id),
          trackingCode: c.tracking_code,
          rawStatus: c.status ?? null,
          raw,
        });
      } catch (e) {
        created.set(only.order.orderNo, {
          error: e instanceof Error ? e.message : "Steadfast create failed",
        });
      }
    } else {
      try {
        const { items, raw } = await createBulkOrder(
          creds,
          chunk.map((c) => c.payload)
        );
        const byInvoice = new Map(items.map((it) => [it.invoice, it]));
        for (const c of chunk) {
          const it = byInvoice.get(c.order.orderNo);
          if (it && it.status === "success" && it.consignment_id) {
            created.set(c.order.orderNo, {
              consignmentId: Number(it.consignment_id),
              trackingCode: it.tracking_code,
              rawStatus: null,
              // Per-shipment log: this order's slice, plus the bulk envelope's
              // top-level fields once — enough to discover undocumented fields.
              raw: { bulk: true, item: it, response_status: raw.status },
            });
          } else {
            created.set(c.order.orderNo, {
              error: it?.note || it?.status || "Steadfast rejected this order",
            });
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Steadfast bulk create failed";
        for (const c of chunk) created.set(c.order.orderNo, { error: msg });
      }
    }
  }

  // ---- 3. record each success via the EXISTING handover logic ----
  for (const { order } of toSend) {
    const res = created.get(order.orderNo);
    if (!res || res.error || !res.consignmentId) {
      results.push({
        orderId: order.id,
        orderNo: order.orderNo,
        ok: false,
        error: res?.error ?? "No consignment returned",
      });
      continue;
    }
    const override = overrides[order.id] ?? {};
    try {
      await prisma.$transaction(async (tx) => {
        const shipment = await applyHandover(
          tx,
          {
            orderId: order.id,
            courierId: courier.id,
            trackingNo: res.trackingCode ?? null,
            handoverDate: new Date(),
            codAmount: Math.max(0, Number(order.codAmount)),
            expectedDelivery: null,
            note: `Sent via Steadfast API, tracking ${res.trackingCode ?? res.consignmentId}`,
            deliveryZone: override.deliveryZone,
            weightKg: override.weightKg,
          },
          userId
        );
        await stampConsignment(tx, shipment.id, {
          consignmentId: res.consignmentId!,
          trackingCode: res.trackingCode ?? null,
          rawStatus: res.rawStatus ?? null,
          rawResponse: res.raw,
          userId,
        });
      });
      results.push({
        orderId: order.id,
        orderNo: order.orderNo,
        ok: true,
        trackingCode: res.trackingCode,
        consignmentId: res.consignmentId,
      });
    } catch (e) {
      // The consignment exists at Steadfast but we failed to record locally —
      // make that explicit so it can be reconciled (rare; e.g. a race).
      results.push({
        orderId: order.id,
        orderNo: order.orderNo,
        ok: false,
        error: `Created at Steadfast (consignment ${res.consignmentId}) but failed to record locally: ${
          e instanceof Error ? e.message : "unknown error"
        }`,
      });
    }
  }

  return results;
}
