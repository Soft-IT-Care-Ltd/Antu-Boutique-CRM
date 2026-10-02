import "server-only";

import type { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import { withTx, type Db } from "@/lib/db/tx";
import type { OrderStatusValue } from "@/lib/orders/constants";
import { orderTrashBlock, type OrderHistoryCounts } from "@/lib/trash/policy";

// PRD §4.18 — moving an order to the trash and back, and bringing back a
// customer when a trashed/archived one orders again. Customers, products
// and leads already had their own trash/restore routes (P1.1, P1.2, P4.1).
// Every move is audit-logged (CLAUDE.md rule 7).

export class TrashError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type AuditContext = { request?: Request };

/** Everything that would make deleting this order rewrite history (lib/trash/policy.ts). */
export async function loadOrderHistory(db: Db, orderId: string): Promise<OrderHistoryCounts | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      status: true,
      leadId: true,
      exchangedFromOrderId: true,
      shipment: { select: { id: true } },
      packagingExpense: { select: { id: true } },
      replacementFor: { select: { id: true } },
      _count: {
        select: {
          payments: true,
          returnCases: true,
          returnInspections: true,
          storeCreditEntries: true,
          fulfilmentActions: true,
          statementLines: true,
          exchangeOrders: true,
        },
      },
    },
  });
  if (!order) return null;
  // The ledger points at orders by (referenceType, referenceId), not a foreign key.
  const stockMovements = await db.stockMovement.count({ where: { referenceType: "ORDER", referenceId: orderId } });
  return {
    status: order.status as OrderStatusValue,
    leadId: order.leadId,
    exchangedFromOrderId: order.exchangedFromOrderId,
    payments: order._count.payments,
    stockMovements,
    shipment: Boolean(order.shipment),
    returnCases: order._count.returnCases,
    returnInspections: order._count.returnInspections,
    storeCreditEntries: order._count.storeCreditEntries,
    fulfilmentActions: order._count.fulfilmentActions,
    statementLines: order._count.statementLines,
    packagingExpense: Boolean(order.packagingExpense),
    exchangeOrders: order._count.exchangeOrders,
    replacementFor: Boolean(order.replacementFor),
  };
}

/** Null when this order may go to the trash, otherwise the reason it can't (shown on the order page). */
export async function orderTrashBlockFor(db: Db, orderId: string): Promise<string | null> {
  const history = await loadOrderHistory(db, orderId);
  return history ? orderTrashBlock(history) : "Order not found";
}

const orderAuditShape = (o: { orderNo: string; status: string; customerId: string | null; total: Prisma.Decimal; deletedAt: Date | null }) => ({
  orderNo: o.orderNo,
  status: o.status,
  customerId: o.customerId,
  total: o.total.toString(),
  deletedAt: o.deletedAt,
});

export async function trashOrder(db: Db, user: SessionUser, id: string, ctx: AuditContext = {}) {
  return withTx(db, async (tx) => {
    const existing = await tx.order.findFirst({ where: scopedWhere({ id, deletedAt: null }, user) });
    if (!existing) throw new TrashError("Order not found", 404);
    // Lock the row so a payment or status move can't land between the check and the delete.
    await tx.$queryRaw`SELECT 1 FROM "orders" WHERE "id" = ${id} FOR UPDATE`;
    const block = await orderTrashBlockFor(tx, id);
    if (block) throw new TrashError(block, 409);
    const trashed = await tx.order.update({ where: { id }, data: { deletedAt: new Date() } });
    await writeAuditLogWith(tx, {
      actorId: user.id,
      action: "order.trash",
      entityType: "order",
      entityId: id,
      before: orderAuditShape(existing),
      after: orderAuditShape(trashed),
      request: ctx.request,
    });
    return trashed;
  });
}

export async function restoreOrder(db: Db, user: SessionUser, id: string, ctx: AuditContext = {}) {
  return withTx(db, async (tx) => {
    const existing = await tx.order.findFirst({ where: scopedWhere({ id, deletedAt: { not: null } }, user) });
    if (!existing) throw new TrashError("Order not found in trash", 404);
    const restored = await tx.order.update({ where: { id }, data: { deletedAt: null } });
    await writeAuditLogWith(tx, {
      actorId: user.id,
      action: "order.restore",
      entityType: "order",
      entityId: id,
      before: orderAuditShape(existing),
      after: orderAuditShape(restored),
      request: ctx.request,
    });
    // An order needs its person: bring them back too if they were deleted.
    if (existing.customerId) await reviveCustomer(tx, existing.customerId, user.id, `Order ${existing.orderNo} was restored from the trash`, ctx);
    return restored;
  });
}

/**
 * A customer in the trash (or archived by the purge) who is back — a new
 * order or sale on their phone, or one of their orders restored — comes out
 * of the trash with their history, instead of a duplicate being made
 * (the phone is unique). A no-op for a live customer.
 */
export async function reviveCustomer(db: Db, customerId: string, actorId: string | null, reason: string, ctx: AuditContext = {}): Promise<void> {
  const customer = await db.customer.findUnique({ where: { id: customerId }, select: { deletedAt: true, archivedAt: true } });
  if (!customer?.deletedAt) return;
  await db.customer.update({ where: { id: customerId }, data: { deletedAt: null, archivedAt: null } });
  await writeAuditLogWith(db, {
    actorId,
    action: "customer.restore",
    entityType: "customer",
    entityId: customerId,
    before: { deletedAt: customer.deletedAt, archivedAt: customer.archivedAt },
    after: { deletedAt: null, archivedAt: null, reason },
    request: ctx.request,
  });
}
