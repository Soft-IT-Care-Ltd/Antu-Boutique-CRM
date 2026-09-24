import "server-only";

import type { Prisma } from "@prisma/client";

import { can } from "@/lib/auth/permissions";
import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import type { CourierShipmentTab } from "@/lib/courier/constants";
import type { CourierReturnRow, ReadyToShipRow, ShipmentDetailView, ShipmentRow } from "@/lib/courier/types";
import { prisma } from "@/lib/prisma";
import { onlineOrderCustomer } from "@/lib/orders/customer";

// Read side of the Courier page and the order-detail shipment card. Every
// query is scoped through scopedWhere() on the order (CLAUDE.md rule 6), and
// every row goes back through stripCostFieldsForUser in the route — the
// courierCost* fields are cost data (rule 5). COD (customer money) is only
// included for callers who can see order money: PRD §3 keeps Packing away
// from customer money data.

export async function canSeeOrderMoney(user: SessionUser): Promise<boolean> {
  return can(user, ["order.view_own", "order.view_team", "order.view_all", "payment.view"]);
}

function orderScope(user: SessionUser, extra: Prisma.OrderWhereInput = {}): Prisma.OrderWhereInput {
  return scopedWhere({ AND: [{ deletedAt: null }, extra] }, user) as Prisma.OrderWhereInput;
}

function orderSearch(q: string | undefined): Prisma.OrderWhereInput {
  if (!q) return {};
  const phone = q.replace(/[\s-]/g, "");
  return {
    OR: [
      { orderNo: { contains: q, mode: "insensitive" } },
      { customer: { name: { contains: q, mode: "insensitive" } } },
      { customer: { phone: { contains: phone } } },
      { shipment: { consignmentId: { contains: q } } },
      { shipment: { trackingCode: { contains: q, mode: "insensitive" } } },
    ],
  };
}

type Page = { page: number; pageSize: number };

export async function listReadyToShip(user: SessionUser, opts: Page & { q?: string }, showMoney: boolean): Promise<{ items: ReadyToShipRow[]; total: number }> {
  const where = orderScope(user, {
    status: "PACKED",
    channel: "ONLINE",
    OR: [{ shipment: null }, { shipment: { bookedAt: null } }],
    ...orderSearch(opts.q),
  });
  const [total, orders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      orderBy: { updatedAt: "asc" },
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
      include: {
        customer: { select: { name: true, phone: true, addressDetail: true, thana: true, district: true } },
        courier: { select: { name: true } },
        items: { select: { qty: true, variant: { select: { product: { select: { name: true } }, size: { select: { name: true } }, color: { select: { name: true } } } } } },
        shipment: { select: { id: true } },
      },
    }),
  ]);
  return {
    total,
    items: orders.map((o) => ({
      orderId: o.id,
      orderNo: o.orderNo,
      customerName: onlineOrderCustomer(o).name,
      phone: onlineOrderCustomer(o).phone,
      address: [onlineOrderCustomer(o).addressDetail, onlineOrderCustomer(o).thana, onlineOrderCustomer(o).district].filter(Boolean).join(", "),
      courierName: o.courier?.name ?? null,
      items: o.items.map((i) => `${i.variant.product.name} (${i.variant.size.name} / ${i.variant.color.name}) ×${i.qty}`),
      bookingInProgress: Boolean(o.shipment),
      ...(showMoney ? { codAmount: Math.max(0, Number(o.dueAmount.toString())).toFixed(2) } : {}),
      packedSince: o.updatedAt.toISOString(),
    })),
  };
}

const shipmentRowInclude = {
  courier: { select: { name: true } },
  order: { select: { id: true, orderNo: true, status: true, customer: { select: { name: true, phone: true } } } },
} satisfies Prisma.ShipmentInclude;

type ShipmentWithOrder = Prisma.ShipmentGetPayload<{ include: typeof shipmentRowInclude }>;

function serializeShipmentRow(s: ShipmentWithOrder, showMoney: boolean): ShipmentRow {
  return {
    shipmentId: s.id,
    orderId: s.order.id,
    orderNo: s.order.orderNo,
    orderStatus: s.order.status,
    customerName: onlineOrderCustomer(s.order).name,
    phone: onlineOrderCustomer(s.order).phone,
    courierName: s.courier.name,
    consignmentId: s.consignmentId,
    trackingCode: s.trackingCode,
    trackingUrl: s.trackingUrl,
    steadfastStatus: s.steadfastStatus,
    subStatus: s.subStatus,
    onHold: s.onHold,
    needsAttention: s.needsAttention,
    attentionReason: s.attentionReason,
    accountsReviewRequired: s.accountsReviewRequired,
    zone: s.zone,
    weightGrams: s.weightGrams,
    courierCostEstimate: s.courierCostEstimate?.toString() ?? null,
    courierCostActual: s.courierCostActual?.toString() ?? null,
    ...(showMoney
      ? { codAmount: s.codAmount.toString(), codCollected: s.codCollected?.toString() ?? null, codReceivedAt: s.codReceivedAt?.toISOString() ?? null }
      : {}),
    bookedAt: s.bookedAt?.toISOString() ?? null,
    deliveredAt: s.deliveredAt?.toISOString() ?? null,
    lastStatusAt: s.lastStatusAt?.toISOString() ?? null,
    finalizedAt: s.finalizedAt?.toISOString() ?? null,
  };
}

const TAB_FILTER: Record<Exclude<CourierShipmentTab, "ready">, Prisma.ShipmentWhereInput> = {
  active: { order: { status: { in: ["HANDED_TO_COURIER", "IN_TRANSIT", "ON_HOLD"] } } },
  attention: { OR: [{ needsAttention: true }, { onHold: true }, { accountsReviewRequired: true }] },
  delivered: { order: { status: { in: ["DELIVERED", "PARTIAL_DELIVERED", "COMPLETED"] } } },
  returned: { order: { status: "RETURNED" } },
};

export async function listShipments(
  user: SessionUser,
  tab: Exclude<CourierShipmentTab, "ready">,
  opts: Page & { q?: string },
  showMoney: boolean,
): Promise<{ items: ShipmentRow[]; total: number }> {
  const where: Prisma.ShipmentWhereInput = {
    AND: [{ bookedAt: { not: null } }, TAB_FILTER[tab], { order: orderScope(user, orderSearch(opts.q)) }],
  };
  const [total, rows] = await Promise.all([
    prisma.shipment.count({ where }),
    prisma.shipment.findMany({
      where,
      include: shipmentRowInclude,
      orderBy: tab === "delivered" ? { deliveredAt: "desc" } : { bookedAt: "desc" },
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
    }),
  ]);
  return { total, items: rows.map((r) => serializeShipmentRow(r, showMoney)) };
}

export async function countShipmentTabs(user: SessionUser): Promise<Record<CourierShipmentTab, number>> {
  const scoped = (filter: Prisma.ShipmentWhereInput) => prisma.shipment.count({ where: { AND: [{ bookedAt: { not: null } }, filter, { order: orderScope(user) }] } });
  const [ready, active, attention, delivered, returned] = await Promise.all([
    prisma.order.count({ where: orderScope(user, { status: "PACKED", channel: "ONLINE", OR: [{ shipment: null }, { shipment: { bookedAt: null } }] }) }),
    scoped(TAB_FILTER.active),
    scoped(TAB_FILTER.attention),
    scoped(TAB_FILTER.delivered),
    scoped(TAB_FILTER.returned),
  ]);
  return { ready, active, attention, delivered, returned };
}

export async function listCourierReturns(user: SessionUser, opts: { status: "open" | "completed" } & Page): Promise<{ items: CourierReturnRow[]; total: number }> {
  const where: Prisma.ReturnInspectionWhereInput = {
    status: opts.status === "open" ? { not: "COMPLETED" } : "COMPLETED",
    order: orderScope(user),
  };
  const [total, rows] = await Promise.all([
    prisma.returnInspection.count({ where }),
    prisma.returnInspection.findMany({
      where,
      orderBy: opts.status === "open" ? { createdAt: "asc" } : { inspectedAt: "desc" },
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
      include: {
        inspectedBy: { select: { name: true } },
        order: {
          select: {
            id: true,
            orderNo: true,
            status: true,
            customer: { select: { name: true, phone: true } },
            shipment: { select: { consignmentId: true, trackingUrl: true } },
            items: {
              where: { unitCostSnapshot: { not: null } },
              select: {
                id: true,
                qty: true,
                returnedQty: true,
                variant: { select: { sku: true, product: { select: { name: true } }, size: { select: { name: true } }, color: { select: { name: true, hexCode: true } } } },
              },
            },
          },
        },
        lines: { select: { orderItemId: true, qty: true, goodQty: true, damagedQty: true } },
      },
    }),
  ]);
  return {
    total,
    items: rows.map((r) => ({
      id: r.id,
      source: r.source,
      status: r.status,
      orderId: r.order.id,
      orderNo: r.order.orderNo,
      orderStatus: r.order.status,
      customerName: onlineOrderCustomer(r.order).name,
      phone: onlineOrderCustomer(r.order).phone,
      consignmentId: r.order.shipment?.consignmentId ?? null,
      trackingUrl: r.order.shipment?.trackingUrl ?? null,
      createdAt: r.createdAt.toISOString(),
      inspectedAt: r.inspectedAt?.toISOString() ?? null,
      inspectedBy: r.inspectedBy?.name ?? null,
      note: r.note,
      items: r.order.items.map((i) => {
        const line = r.lines.find((l) => l.orderItemId === i.id) ?? null;
        return {
          orderItemId: i.id,
          productName: i.variant.product.name,
          sku: i.variant.sku,
          sizeName: i.variant.size.name,
          colorName: i.variant.color.name,
          colorHex: i.variant.color.hexCode,
          orderedQty: i.qty,
          expectedBackQty: line?.qty ?? 0,
          goodQty: line?.goodQty ?? 0,
          damagedQty: line?.damagedQty ?? 0,
        };
      }),
    })),
  };
}

/** The shipment card on the order detail page (tracking timeline included). Null when the order has no booked shipment. */
export async function loadShipmentDetail(orderId: string, showMoney: boolean): Promise<ShipmentDetailView | null> {
  const s = await prisma.shipment.findUnique({
    where: { orderId },
    include: {
      ...shipmentRowInclude,
      bookedBy: { select: { name: true } },
      trackingEvents: { orderBy: { eventAt: "desc" }, take: 50 },
    },
  });
  if (!s?.bookedAt) return null;
  return {
    ...serializeShipmentRow(s, showMoney),
    bookedBy: s.bookedBy?.name ?? null,
    trackingEvents: s.trackingEvents.map((e) => ({ id: e.id, message: e.message, eventAt: e.eventAt.toISOString(), source: e.source })),
  };
}
