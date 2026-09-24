import "server-only";

import { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import type { SessionUser } from "@/lib/auth/types";
import { isValidBdPhone, normalizeBdPhone } from "@/lib/customers/phone";
import { withTx, type Db } from "@/lib/db/tx";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { lockVariant, recordStockMovement } from "@/lib/inventory/ledger";
import { WALK_IN_CUSTOMER_LABEL } from "@/lib/orders/customer";
import { generateOrderNumber } from "@/lib/orders/order-number";
import { isPriceBelowFloor } from "@/lib/orders/price-floor";
import { recomputeOrderDueAmount } from "@/lib/orders/totals";
import { formatBDT, toNumber } from "@/lib/money";
import { CartError, priceCart, settleTenders } from "@/lib/pos/cart";
import type { PosPaymentMethod } from "@/lib/pos/constants";
import { lockOpenDrawerForSale } from "@/lib/pos/drawer";
import type { PosSaleResult } from "@/lib/pos/types";
import { resolvePaymentWalletId } from "@/lib/wallets/service";

// PRD §4.7 — a showroom sale, start to finish, in ONE transaction:
//
//   - channel WALK_IN, no courier, no delivery address, customer optional
//   - never CONFIRMED (so no reservation, and no allocated ad cost — P2.3):
//     created straight at COMPLETED, with a status-history row saying so
//   - stock leaves immediately as POS_SALE_OUT through the ledger (CLAUDE.md
//     rule 2), and each line's unit_cost_snapshot is frozen at that moment
//     at the same weighted average cost the ledger row carries (rule 3)
//   - the tenders pay the total exactly; payments land in the same payments
//     and wallets tables as online ones, due_amount recomputed (rule 1)
//   - cash goes into today's open drawer (Showroom Cash); the day-end count
//     verifies it. Card, bKash and Nagad wait in the Accounts queue.

export class PosSaleError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type PosSaleItemInput = { variantId: string; qty: number; unitPrice: number; lineDiscount: number; stockOverrideReason?: string | null };

export type PosTenderInput = { method: PosPaymentMethod; amount: number; tendered?: number | null; walletId?: string | null; transactionId?: string | null };

export type PosSaleInput = {
  items: PosSaleItemInput[];
  cartDiscount: number;
  customer?: { phone: string; name?: string | null } | null;
  tenders: PosTenderInput[];
  note?: string | null;
};

export type PosContext = {
  user: SessionUser;
  /** The showroom drawer's wallet (lib/pos/drawer.ts getPosCashWalletId). */
  cashWalletId: string;
  hasCostAccess: boolean;
  hasStockOverride: boolean;
  canCreateCustomer: boolean;
};

async function resolveCustomer(tx: Prisma.TransactionClient, ctx: PosContext, input: PosSaleInput["customer"]): Promise<{ id: string; name: string } | null> {
  const phone = input?.phone?.trim();
  if (!phone) return null;
  if (!isValidBdPhone(phone)) throw new PosSaleError("Enter a valid Bangladeshi phone number (e.g. 017XXXXXXXX), or leave it blank for an anonymous sale.");
  const normalized = normalizeBdPhone(phone);
  // Dedupe on phone across everyone's customers (PRD §4.4), as the online
  // form does. The existing record is linked, never edited or shown here —
  // it may belong to another executive.
  const existing = await tx.customer.findUnique({ where: { phone: normalized }, select: { id: true, name: true } });
  if (existing) return existing;
  if (!ctx.canCreateCustomer) throw new PosSaleError("You don't have permission to add a new customer.", 403);
  const created = await tx.customer.create({
    data: { name: input?.name?.trim() || WALK_IN_CUSTOMER_LABEL, phone: normalized, createdById: ctx.user.id, teamId: ctx.user.teamId },
    select: { id: true, name: true },
  });
  return created;
}

export async function createPosSale(db: Db, ctx: PosContext, input: PosSaleInput): Promise<PosSaleResult> {
  if (input.items.length === 0) throw new PosSaleError("The cart is empty.");

  let priced;
  try {
    priced = priceCart(
      input.items.map((item, index) => ({ key: String(index), qty: item.qty, unitPrice: item.unitPrice, lineDiscount: item.lineDiscount })),
      input.cartDiscount,
    );
  } catch (error) {
    if (error instanceof CartError) throw new PosSaleError(error.message);
    throw error;
  }

  const settled = settleTenders(priced.totalPaisa, input.tenders);
  for (const t of input.tenders) {
    if (toPaisa(t.amount) <= 0) throw new PosSaleError("Each payment needs an amount.");
    if (t.method !== "CASH" && t.tendered != null) throw new PosSaleError("Only cash can be over-tendered for change.");
    if (t.method === "CASH" && t.tendered != null && toPaisa(t.tendered) < toPaisa(t.amount)) throw new PosSaleError("Cash handed over is less than the cash amount.");
  }
  if (settled.remainingPaisa > 0) throw new PosSaleError(`${formatBDT(fromPaisa(settled.remainingPaisa))} still to pay.`);
  if (settled.remainingPaisa < 0) throw new PosSaleError(`The payments are ${formatBDT(fromPaisa(-settled.remainingPaisa))} more than the total — give the extra back as change.`);
  const takesCash = input.tenders.some((t) => t.method === "CASH");

  return withTx(db, async (tx) => {
    // Cash needs today's drawer open — and holds it (FOR SHARE) so a close
    // can't count the drawer while this sale's cash is on its way in.
    const drawer = takesCash ? await lockOpenDrawerForSale(tx, ctx.cashWalletId) : null;

    // Lock every variant (in id order, so two tills can't deadlock) before
    // reading stock and cost — nothing can move them between check and write.
    const variantIds = [...new Set(input.items.map((i) => i.variantId))].sort();
    for (const id of variantIds) {
      if (!(await lockVariant(tx, id))) throw new PosSaleError("One of the items is no longer in the catalog.");
    }
    const variants = await tx.productVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, sku: true, stockQty: true, reservedQty: true, weightedAvgCost: true, isActive: true, product: { select: { name: true, isActive: true, deletedAt: true } } },
    });
    const variantById = new Map(variants.map((v) => [v.id, v]));

    const wanted = new Map<string, number>();
    for (const item of input.items) wanted.set(item.variantId, (wanted.get(item.variantId) ?? 0) + item.qty);

    const overrideByVariant = new Map<string, string>();
    for (const item of input.items) {
      const v = variantById.get(item.variantId);
      if (!v || !v.isActive || !v.product.isActive || v.product.deletedAt) throw new PosSaleError(`${v?.sku ?? "An item"} is no longer for sale.`);
      if (isPriceBelowFloor(item.unitPrice, toNumber(v.weightedAvgCost), ctx.hasCostAccess)) {
        throw new PosSaleError(`The price for ${v.sku} is below the minimum allowed. Raise it, or ask a Manager/Admin.`);
      }
      // PRD §6 rule 7: selling below available stock needs an Admin/Manager
      // override with a reason. Reserved units belong to online orders.
      const available = v.stockQty - v.reservedQty;
      const qty = wanted.get(v.id)!;
      if (qty > available) {
        const reason = item.stockOverrideReason?.trim();
        if (!ctx.hasStockOverride) throw new PosSaleError(`Only ${Math.max(0, available)} of ${v.sku} available (${qty} in the cart). Ask a Manager to check the stock.`);
        if (!reason && !overrideByVariant.has(v.id)) throw new PosSaleError(`A reason is required to sell ${v.sku} beyond available stock.`);
        if (reason) overrideByVariant.set(v.id, reason);
      }
    }

    const customer = await resolveCustomer(tx, ctx, input.customer);
    const orderNo = await generateOrderNumber(tx);
    const order = await tx.order.create({
      data: {
        orderNo,
        channel: "WALK_IN",
        status: "COMPLETED",
        customerId: customer?.id ?? null,
        deliveryCharge: 0,
        subtotal: fromPaisa(priced.subtotalPaisa),
        discountTotal: fromPaisa(priced.discountPaisa),
        total: fromPaisa(priced.totalPaisa),
        dueAmount: fromPaisa(priced.totalPaisa),
        internalNote: input.note?.trim() || null,
        createdById: ctx.user.id,
        teamId: ctx.user.teamId,
      },
    });

    const lineAudit: unknown[] = [];
    for (const [index, item] of input.items.entries()) {
      const v = variantById.get(item.variantId)!;
      const line = priced.lines[index];
      const overrideReason = overrideByVariant.get(v.id) ?? null;
      await tx.orderItem.create({
        data: {
          orderId: order.id,
          variantId: v.id,
          qty: item.qty,
          unitPrice: fromPaisa(line.unitPricePaisa),
          lineDiscount: fromPaisa(line.discountPaisa),
          // Frozen now, never again (CLAUDE.md rule 3): a POS sale's stock
          // leaves at this moment, at this cost.
          unitCostSnapshot: v.weightedAvgCost,
          stockOverride: overrideReason !== null,
          stockOverrideReason: overrideReason,
        },
      });
      await recordStockMovement(tx, {
        variantId: v.id,
        type: "POS_SALE_OUT",
        qty: -item.qty,
        unitCost: v.weightedAvgCost,
        referenceType: "ORDER",
        referenceId: order.id,
        actorId: ctx.user.id,
        note: overrideReason ? `Sold beyond available stock: ${overrideReason}` : null,
      });
      lineAudit.push({ sku: v.sku, qty: item.qty, unitPrice: fromPaisa(line.unitPricePaisa), lineDiscount: fromPaisa(line.discountPaisa), stockOverrideReason: overrideReason });
    }

    const tenderAudit: unknown[] = [];
    for (const t of input.tenders) {
      const change = t.method === "CASH" && t.tendered != null ? toPaisa(t.tendered) - toPaisa(t.amount) : 0;
      const payment = await tx.payment.create({
        data: {
          orderId: order.id,
          amount: t.amount,
          method: t.method,
          // Cash always lands in the drawer's wallet; the rest by method.
          walletId: t.method === "CASH" ? ctx.cashWalletId : await resolvePaymentWalletId(tx, t.method, t.walletId),
          transactionId: t.transactionId || null,
          receivedById: ctx.user.id,
          verified: false,
          cashTendered: t.method === "CASH" && t.tendered != null ? t.tendered : null,
          note: change > 0 ? `Tendered ${formatBDT(t.tendered!)}, change ${formatBDT(fromPaisa(change))}` : null,
        },
      });
      tenderAudit.push({ paymentId: payment.id, method: t.method, amount: t.amount, walletId: payment.walletId, transactionId: payment.transactionId });
    }

    const due = await recomputeOrderDueAmount(tx, order.id);
    if (toPaisa(due) !== 0) throw new PosSaleError("The payments don't add up to the total.");

    await tx.orderStatusHistory.create({
      data: { orderId: order.id, fromStatus: null, toStatus: "COMPLETED", changedById: ctx.user.id, note: "Showroom sale (POS) — paid in full at the counter" },
    });

    await writeAuditLogWith(tx, {
      actorId: ctx.user.id,
      action: "pos.sale",
      entityType: "order",
      entityId: order.id,
      after: {
        orderNo,
        channel: "WALK_IN",
        customerId: customer?.id ?? null,
        subtotal: fromPaisa(priced.subtotalPaisa),
        cartDiscount: input.cartDiscount,
        discountTotal: fromPaisa(priced.discountPaisa),
        total: fromPaisa(priced.totalPaisa),
        lines: lineAudit,
        tenders: tenderAudit,
        change: fromPaisa(settled.changePaisa),
        drawerId: drawer?.id ?? null,
      },
    });

    return {
      orderId: order.id,
      orderNo,
      total: fromPaisa(priced.totalPaisa),
      change: fromPaisa(settled.changePaisa),
      customerName: customer?.name ?? null,
    };
  });
}

/** A reused bKash/Nagad TrxID (CLAUDE.md rule 4) or an order-number race, as a sale error. */
export function posSaleConflict(error: unknown): PosSaleError | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    const target = Array.isArray(error.meta?.target) ? error.meta.target.join(",") : String(error.meta?.target ?? "");
    if (target.includes("orderNo")) return new PosSaleError("Could not generate a unique order number — please try again.", 409);
    return new PosSaleError("This transaction ID has already been used.", 409);
  }
  return null;
}
