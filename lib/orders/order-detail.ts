import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/money";
import type { DeliveryZoneValue, OrderEditRequestStatusValue, OrderStatusValue, PaymentMethodValue } from "@/lib/orders/constants";
import type { OrderDetail } from "@/lib/orders/types";

const orderDetailInclude = {
  customer: true,
  courier: { select: { id: true, name: true } },
  courierZone: { select: { id: true, zone: true } },
  createdBy: { select: { id: true, name: true } },
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
  images: {
    where: { deletedAt: null },
    orderBy: { uploadedAt: "asc" },
  },
  payments: {
    include: { receivedBy: { select: { id: true, name: true } } },
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

export async function loadOrderDetail(id: string) {
  return prisma.order.findFirst({
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

export function serializeOrderDetail(order: LoadedOrder): OrderDetail {
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status as OrderStatusValue,
    channel: order.channel,
    customer: {
      id: order.customer.id,
      name: order.customer.name,
      phone: order.customer.phone,
      altPhone: order.customer.altPhone,
      division: order.customer.division,
      district: order.customer.district,
      thana: order.customer.thana,
      addressDetail: order.customer.addressDetail,
    },
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
      lineTotal: (item.qty * toNumber(item.unitPrice) - toNumber(item.lineDiscount)).toFixed(2),
      unitCostSnapshot: item.unitCostSnapshot?.toString() ?? null,
      stockOverride: item.stockOverride,
      stockOverrideReason: item.stockOverrideReason,
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
      wallet: payment.wallet,
      transactionId: payment.transactionId,
      paidAt: payment.paidAt.toISOString(),
      receivedBy: payment.receivedBy,
      verified: payment.verified,
      note: payment.note,
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
