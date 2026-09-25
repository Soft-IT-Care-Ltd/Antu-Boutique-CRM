import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { hoursSince, isOverdue } from "@/lib/packing/sla";
import type { OrderStatusValue } from "@/lib/orders/constants";
import type { PackingOrderDetail, PackingQueueItem, PackingView } from "@/lib/packing/types";
import { dhakaDayStartUtc, todayInDhaka } from "@/lib/inventory/constants";
import { onlineOrderCustomer } from "@/lib/orders/customer";
import { packagingForDisplay, type PackagingNeed } from "@/lib/packaging/consume";

// PRD §4.8 "must not see customer money data": this include is the money
// boundary, not just serializePacking*'s output shape — subtotal, total,
// dueAmount and payments are never selected here, so there is no field for
// a bug in the serializer to accidentally leak later (belt-and-braces with
// CLAUDE.md rule 5's "the JSON response must not contain the field").
const packingOrderInclude = {
  customer: {
    select: { name: true, phone: true, altPhone: true, division: true, district: true, thana: true, addressDetail: true },
  },
  items: {
    include: {
      // P3.3 — the outfit set a line is a component of: packing sees the
      // full explosion, every component with its chosen size and colour.
      setLine: { select: { id: true, name: true, qty: true } },
      variant: {
        select: {
          sku: true,
          product: { select: { name: true } },
          size: { select: { name: true } },
          color: { select: { name: true, hexCode: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  },
  images: {
    where: { deletedAt: null },
    orderBy: { uploadedAt: "asc" },
  },
  statusHistory: {
    where: { toStatus: "PACKED" },
    include: { changedBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: 1,
  },
} satisfies Prisma.OrderInclude;

type PackingOrderRow = Prisma.OrderGetPayload<{ include: typeof packingOrderInclude }>;

function serializeCommon(order: PackingOrderRow, slaHours: number): PackingQueueItem {
  return {
    id: order.id,
    orderNo: order.orderNo,
    customer: { name: onlineOrderCustomer(order).name, phone: onlineOrderCustomer(order).phone },
    internalNote: order.internalNote,
    items: order.items.map((item) => ({
      id: item.id,
      productName: item.variant.product.name,
      sku: item.variant.sku,
      sizeName: item.variant.size.name,
      colorName: item.variant.color.name,
      colorHex: item.variant.color.hexCode,
      qty: item.qty,
      set: item.setLine ? { id: item.setLine.id, name: item.setLine.name, qty: item.setLine.qty } : null,
    })),
    images: order.images.map((image) => ({
      id: image.id,
      filePath: image.filePath,
      thumbPath: image.thumbPath,
      caption: image.caption,
    })),
    createdAt: order.createdAt.toISOString(),
    hoursOpen: Math.round(hoursSince(order.createdAt) * 10) / 10,
    isOverdue: order.status === "CONFIRMED" && isOverdue(order.createdAt, slaHours),
    packedAt: order.status === "CONFIRMED" ? null : (order.statusHistory[0]?.createdAt.toISOString() ?? null),
  };
}

export function serializePackingQueueItem(order: PackingOrderRow, slaHours: number): PackingQueueItem {
  return serializeCommon(order, slaHours);
}

export function serializePackingOrderDetail(order: PackingOrderRow & { packaging?: PackagingNeed[] }, slaHours: number): PackingOrderDetail {
  const packedEntry = order.statusHistory[0] ?? null;
  const customer = onlineOrderCustomer(order);
  return {
    ...serializeCommon(order, slaHours),
    status: order.status as OrderStatusValue,
    customer: {
      name: customer.name,
      phone: customer.phone,
      altPhone: customer.altPhone,
      division: customer.division,
      district: customer.district,
      thana: customer.thana,
      addressDetail: customer.addressDetail,
    },
    packedBy: packedEntry?.changedBy ?? null,
    packaging: (order.packaging ?? []).map((p) => ({ label: p.label, sku: p.sku, qty: p.qty })),
  };
}

export type PackingQueuePageParams = {
  q?: string;
  view?: PackingView;
  page: number;
  pageSize: number;
};

/**
 * P4.3 — one packing view's orders. Online parcels only: a walk-in sale
 * leaves over the counter and never reaches Packing. The Packing
 * dashboard counts with this same where, so its numbers match the screen.
 */
export function packingViewWhere(view: PackingView, slaHours: number, now = new Date()): Prisma.OrderWhereInput {
  const base: Prisma.OrderWhereInput = { deletedAt: null, channel: "ONLINE" };
  switch (view) {
    case "queue":
      return { ...base, status: "CONFIRMED" };
    case "overdue":
      return { ...base, status: "CONFIRMED", createdAt: { lt: new Date(now.getTime() - slaHours * 60 * 60 * 1000) } };
    case "ready":
      return { ...base, status: "PACKED" };
    case "packed_today":
      return { ...base, statusHistory: { some: { toStatus: "PACKED", createdAt: { gte: dhakaDayStartUtc(todayInDhaka()) } } } };
  }
}

// PRD §4.8: "packing queue — all CONFIRMED orders, oldest first." Not
// scoped via lib/auth/scope.ts (SE-own/TL-team) — Packing works every
// order regardless of who created it, same as Accounts' order.view_all
// today, just without a money-carrying permission attached (see the
// comment on ROLE_TEMPLATES.PACKING).
export async function loadPackingQueuePage(params: PackingQueuePageParams, slaHours: number) {
  const { q, page, pageSize, view = "queue" } = params;

  const where: Prisma.OrderWhereInput = packingViewWhere(view, slaHours);
  if (q) {
    where.OR = [
      { orderNo: { contains: q, mode: "insensitive" } },
      { customer: { name: { contains: q, mode: "insensitive" } } },
      { customer: { phone: { contains: q.replace(/[\s-]/g, "") } } },
    ];
  }

  const [total, orders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      // The queue is worked oldest first; what's been packed today reads newest first.
      orderBy: { createdAt: view === "packed_today" ? "desc" : "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: packingOrderInclude,
    }),
  ]);

  return { total, orders };
}

/**
 * Any non-deleted order, any status — used by the packing detail screen
 * (pre- or post-PACKED, for reprinting the slip). With the packaging the
 * parcel takes (P3.3): what was used once packed, what will be before.
 */
export async function loadPackingOrder(orderId: string, db: Prisma.TransactionClient = prisma): Promise<(PackingOrderRow & { packaging: PackagingNeed[] }) | null> {
  const order = await db.order.findFirst({
    where: { id: orderId, deletedAt: null },
    include: packingOrderInclude,
  });
  if (!order) return null;
  return { ...order, packaging: await packagingForDisplay(db, order.id, order.channel === "WALK_IN" ? "POS_SALE" : "ONLINE_PARCEL") };
}
