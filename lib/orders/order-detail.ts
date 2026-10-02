import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/money";
import { keptLine } from "@/lib/orders/totals";
import type { DeliveryZoneValue, OrderEditRequestStatusValue, OrderStatusValue, PaymentMethodValue } from "@/lib/orders/constants";
import type { LineFulfilment } from "@/lib/fulfilment/constants";
import type { OrderDetail } from "@/lib/orders/types";

const orderDetailInclude = {
  customer: true,
  courier: { select: { id: true, name: true } },
  courierZone: { select: { id: true, zone: true } },
  createdBy: { select: { id: true, name: true } },
  // P4.1 — the lead this order converted, if any.
  lead: { select: { id: true, name: true, source: true } },
  items: {
    include: {
      variant: {
        include: {
          product: { select: { id: true, name: true } },
          size: { select: { name: true } },
          color: { select: { name: true, hexCode: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  },
  // P3.3 — outfit sets; their components are among `items` (setLineId).
  setLines: { orderBy: { createdAt: "asc" } },
  images: {
    where: { deletedAt: null },
    orderBy: { uploadedAt: "asc" },
  },
  payments: {
    include: {
      receivedBy: { select: { id: true, name: true } },
      verifiedBy: { select: { id: true, name: true } },
      decidedBy: { select: { id: true, name: true } },
      wallet: { select: { id: true, name: true } },
      courierStatementLine: { select: { id: true } },
    },
    orderBy: { paidAt: "asc" },
  },
  statusHistory: {
    include: { changedBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  },
  invoices: { orderBy: { version: "asc" } },
  editRequests: {
    include: {
      requestedBy: { select: { id: true, name: true } },
      reviewedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  },
} satisfies Prisma.OrderInclude;

export type LoadedOrder = NonNullable<Awaited<ReturnType<typeof loadOrderDetail>>>;

/** `db` defaults to the app client; tests pass their rolled-back transaction. */
export async function loadOrderDetail(id: string, db: Prisma.TransactionClient = prisma) {
  return db.order.findFirst({
    where: { id, deletedAt: null },
    include: orderDetailInclude,
  });
}

export async function loadOrderDetailByNo(orderNo: string) {
  return prisma.order.findFirst({
    where: { orderNo, deletedAt: null },
    include: orderDetailInclude,
  });
}

/** C5 — the line's stored split (null once the order isn't confirmed). */
function lineFulfilment(order: LoadedOrder, item: LoadedOrder["items"][number]): LineFulfilment | null {
  if (order.fulfilmentStatus === null) return null;
  const from = Array.isArray(item.transferFrom) ? (item.transferFrom as { locationId: string; locationName?: string; qty: number }[]) : [];
  return {
    atHub: item.atHubQty,
    incoming: item.incomingQty,
    fromLocations: from.map((f) => ({ locationId: f.locationId, locationName: f.locationName ?? "Another location", qty: f.qty })),
    backorder: item.backorderQty,
  };
}

export function serializeOrderDetail(order: LoadedOrder): OrderDetail {
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status as OrderStatusValue,
    channel: order.channel,
    customer: order.customer
      ? {
          id: order.customer.id,
          name: order.customer.name,
          phone: order.customer.phone,
          altPhone: order.customer.altPhone,
          division: order.customer.division,
          district: order.customer.district,
          thana: order.customer.thana,
          addressDetail: order.customer.addressDetail,
        }
      : null,
    courier: order.courier,
    courierZoneId: order.courierZone?.id ?? null,
    deliveryZone: (order.courierZone?.zone as DeliveryZoneValue | undefined) ?? null,
    deliveryCharge: order.deliveryCharge.toString(),
    expectedDeliveryDate: order.expectedDeliveryDate?.toISOString() ?? null,
    subtotal: order.subtotal.toString(),
    discountTotal: order.discountTotal.toString(),
    total: order.total.toString(),
    dueAmount: order.dueAmount.toString(),
    internalNote: order.internalNote,
    deliveryNote: order.deliveryNote,
    fulfilmentStatus: order.fulfilmentStatus,
    waitingSince: order.waitingSince?.toISOString() ?? null,
    stockExpectedOn: order.stockExpectedOn?.toISOString() ?? null,
    exchangedFromOrderId: order.exchangedFromOrderId,
    lead: order.lead,
    items: order.items.map((item) => ({
      id: item.id,
      variantId: item.variantId,
      productId: item.variant.product.id,
      productName: item.variant.product.name,
      sku: item.variant.sku,
      sizeName: item.variant.size.name,
      colorName: item.variant.color.name,
      colorHex: item.variant.color.hexCode,
      qty: item.qty,
      unitPrice: item.unitPrice.toString(),
      lineDiscount: item.lineDiscount.toString(),
      // On the kept quantity (P2.2 partial delivery) — equal to qty × price − discount when nothing came back.
      lineTotal: keptLine({ qty: item.qty, returnedQty: item.returnedQty, unitPrice: toNumber(item.unitPrice), lineDiscount: toNumber(item.lineDiscount) }).lineTotal.toFixed(2),
      unitCostSnapshot: item.unitCostSnapshot?.toString() ?? null,
      stockOverride: item.stockOverride,
      stockOverrideReason: item.stockOverrideReason,
      returnedQty: item.returnedQty,
      setLineId: item.setLineId,
      fulfilment: lineFulfilment(order, item),
    })),
    setLines: order.setLines.map((s) => ({
      id: s.id,
      setId: s.outfitSetId,
      name: s.name,
      qty: s.qty,
      unitPrice: s.unitPrice.toFixed(2),
      lineDiscount: s.lineDiscount.toFixed(2),
      itemIds: order.items.filter((i) => i.setLineId === s.id).map((i) => i.id),
    })),
    images: order.images.map((image) => ({
      id: image.id,
      orderItemId: image.orderItemId,
      filePath: image.filePath,
      thumbPath: image.thumbPath,
      caption: image.caption,
      uploadedAt: image.uploadedAt.toISOString(),
    })),
    payments: order.payments.map((payment) => ({
      id: payment.id,
      amount: payment.amount.toString(),
      method: payment.method as PaymentMethodValue,
      kind: payment.kind,
      walletId: payment.walletId,
      walletName: payment.wallet?.name ?? null,
      transactionId: payment.transactionId,
      paidAt: payment.paidAt.toISOString(),
      receivedBy: payment.receivedBy,
      verified: payment.verified,
      verifiedBy: payment.verifiedBy,
      verifiedAt: payment.verifiedAt?.toISOString() ?? null,
      note: payment.note,
      refundReason: payment.refundReason,
      refundStatus: payment.refundStatus,
      decidedBy: payment.decidedBy,
      decidedAt: payment.decidedAt?.toISOString() ?? null,
      decisionNote: payment.decisionNote,
      fromCourierStatement: payment.courierStatementLine !== null,
    })),
    statusHistory: order.statusHistory.map((entry) => ({
      id: entry.id,
      fromStatus: entry.fromStatus as OrderStatusValue | null,
      toStatus: entry.toStatus as OrderStatusValue,
      note: entry.note,
      changedBy: entry.changedBy,
      createdAt: entry.createdAt.toISOString(),
    })),
    invoices: order.invoices.map((invoice) => ({
      id: invoice.id,
      version: invoice.version,
      filePath: invoice.filePath,
      createdAt: invoice.createdAt.toISOString(),
    })),
    editRequests: order.editRequests.map((request) => ({
      id: request.id,
      status: request.status as OrderEditRequestStatusValue,
      proposedChanges: request.proposedChanges,
      requestedBy: request.requestedBy,
      reviewedBy: request.reviewedBy,
      reviewedAt: request.reviewedAt?.toISOString() ?? null,
      reviewNote: request.reviewNote,
      createdAt: request.createdAt.toISOString(),
    })),
    createdBy: order.createdBy,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}
