import "server-only";

import type { Prisma } from "@prisma/client";

import type { OrderListItem } from "@/lib/orders/types";

const listItemInclude = {
  customer: { select: { id: true, name: true, phone: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.OrderInclude;

export type OrderListRow = Prisma.OrderGetPayload<{ include: typeof listItemInclude }>;

export const ORDER_LIST_INCLUDE = listItemInclude;

export function serializeOrderListItem(order: OrderListRow): OrderListItem {
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    channel: order.channel,
    customer: order.customer,
    total: order.total.toString(),
    dueAmount: order.dueAmount.toString(),
    createdBy: order.createdBy,
    expectedDeliveryDate: order.expectedDeliveryDate?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
  };
}
