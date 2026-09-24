import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { hoursSince, isOverdue } from "@/lib/packing/sla";
import type { OrderStatusValue } from "@/lib/orders/constants";
import type { PackingOrderDetail, PackingQueueItem } from "@/lib/packing/types";
import { onlineOrderCustomer } from "@/lib/orders/customer";

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
    })),
    images: order.images.map((image) => ({
      id: image.id,
      filePath: image.filePath,
      thumbPath: image.thumbPath,
      caption: image.caption,
    })),
    createdAt: order.createdAt.toISOString(),
    hoursOpen: Math.round(hoursSince(order.createdAt) * 10) / 10,
    isOverdue: isOverdue(order.createdAt, slaHours),
  };
}

export function serializePackingQueueItem(order: PackingOrderRow, slaHours: number): PackingQueueItem {
  return serializeCommon(order, slaHours);
}

export function serializePackingOrderDetail(order: PackingOrderRow, slaHours: number): PackingOrderDetail {
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
    packedAt: packedEntry?.createdAt.toISOString() ?? null,
    packedBy: packedEntry?.changedBy ?? null,
  };
}

export type PackingQueuePageParams = {
  q?: string;
  page: number;
  pageSize: number;
};

// PRD §4.8: "packing queue — all CONFIRMED orders, oldest first." Not
// scoped via lib/auth/scope.ts (SE-own/TL-team) — Packing works every
// order regardless of who created it, same as Accounts' order.view_all
// today, just without a money-carrying permission attached (see the
// comment on ROLE_TEMPLATES.PACKING).
export async function loadPackingQueuePage(params: PackingQueuePageParams) {
  const { q, page, pageSize } = params;

  const where: Prisma.OrderWhereInput = { status: "CONFIRMED", deletedAt: null };
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
      orderBy: { createdAt: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: packingOrderInclude,
    }),
  ]);

  return { total, orders };
}

/** Any non-deleted order, any status — used by the packing detail screen (pre- or post-PACKED, for reprinting the slip). */
export async function loadPackingOrder(orderId: string): Promise<PackingOrderRow | null> {
  return prisma.order.findFirst({
    where: { id: orderId, deletedAt: null },
    include: packingOrderInclude,
  });
}
