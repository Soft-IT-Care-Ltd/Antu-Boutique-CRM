import type { Prisma } from "@prisma/client";

import type { SessionUser } from "@/lib/auth/types";
import { recordStockMovement } from "@/lib/inventory/ledger";
import { moveOrderStatus } from "@/lib/orders/lifecycle";
import { packOrder } from "@/lib/orders/pack";
import { reserveVariantStock } from "@/lib/orders/stock";
import { computeOrderTotals, recomputeOrderDueAmount } from "@/lib/orders/totals";
import { completeConditionCheck } from "@/lib/returns/condition-check";
import { createCounterExchange, decideReturnCase, requestReturnCase } from "@/lib/returns/cases";
import { testProductCode, testSku } from "@/lib/test/catalog-codes";
import { resolvePaymentWalletId } from "@/lib/wallets/service";

// P3.2 fixtures: real delivered orders built through the real services
// (reserve → pack → courier statuses), and the three flows the Phase 2
// ledger test replays — an online exchange, a counter exchange and a return
// with one damaged unit. Everything runs inside the caller's rolled-back
// transaction (lib/test/rollback.ts).

export const PHONES = { ADMIN: "01711000001", MANAGER: "01711000002", TL: "01711000003", SE: "01711000004", PACKING: "01711000005", ACCOUNTS: "01711000006", POS: "01711000007" } as const;

export async function userFor(tx: Prisma.TransactionClient, phone: string): Promise<SessionUser> {
  const user = await tx.user.findUniqueOrThrow({ where: { phone }, select: { id: true, teamId: true, role: { select: { name: true } } } });
  return { id: user.id, role: user.role.name, teamId: user.teamId };
}

let phoneSeq = 0;
export const freshPhone = () => `017${String(Date.now() % 1e6).padStart(6, "0")}${String(++phoneSeq % 100).padStart(2, "0")}`;

/**
 * One product in the first three sizes of one colour (`m`, `l`, `xl` — stock
 * 10 each at cost 400), plus a pricier (৳2,200) and a cheaper (৳900) product.
 */
export async function scratchCatalog(tx: Prisma.TransactionClient) {
  const sizes = await tx.size.findMany({ orderBy: { sortOrder: "asc" }, take: 3 });
  const color = await tx.color.findFirstOrThrow({ orderBy: { sortOrder: "asc" } });
  const code = testProductCode();
  const product = await tx.product.create({ data: { code, name: `Exchange test ${code}`, basePrice: 1450 } });
  const variants = [];
  for (const [i, size] of sizes.entries()) {
    const v = await tx.productVariant.create({ data: { productId: product.id, sizeId: size.id, colorId: color.id, sku: testSku(code, `${size.code}${i}`), weightedAvgCost: 400 } });
    await recordStockMovement(tx, { variantId: v.id, type: "PURCHASE_IN", qty: 10, unitCost: 400, referenceType: "OPENING_BALANCE", actorId: null });
    variants.push(v);
  }
  const code2 = testProductCode();
  const pricier = await tx.product.create({ data: { code: code2, name: `Exchange test pricier ${code2}`, basePrice: 2200 } });
  const other = await tx.productVariant.create({ data: { productId: pricier.id, sizeId: sizes[0].id, colorId: color.id, sku: testSku(code2), weightedAvgCost: 900 } });
  await recordStockMovement(tx, { variantId: other.id, type: "PURCHASE_IN", qty: 10, unitCost: 900, referenceType: "OPENING_BALANCE", actorId: null });
  const cheapCode = testProductCode();
  const cheaper = await tx.product.create({ data: { code: cheapCode, name: `Exchange test cheaper ${cheapCode}`, basePrice: 900 } });
  const cheap = await tx.productVariant.create({ data: { productId: cheaper.id, sizeId: sizes[0].id, colorId: color.id, sku: testSku(cheapCode), weightedAvgCost: 300 } });
  await recordStockMovement(tx, { variantId: cheap.id, type: "PURCHASE_IN", qty: 10, unitCost: 300, referenceType: "OPENING_BALANCE", actorId: null });
  return { product, m: variants[0], l: variants[1], xl: variants[2], pricier: other, cheaper: cheap };
}

/**
 * A DELIVERED online order sold by the demo SE: `qty` units of `variantId` at
 * ৳1,450 less a ৳100 line discount, ৳80 delivery, paid in full by bKash
 * (verified), packed through packOrder and walked through the courier statuses.
 */
export async function deliveredOrder(tx: Prisma.TransactionClient, variantId: string, opts: { qty?: number; channel?: "ONLINE" | "WALK_IN" } = {}) {
  const [se, admin, packer] = await Promise.all([userFor(tx, PHONES.SE), userFor(tx, PHONES.ADMIN), userFor(tx, PHONES.PACKING)]);
  const qty = opts.qty ?? 1;
  const customer = await tx.customer.create({ data: { name: "Exchange Test Customer", phone: freshPhone(), createdById: se.id, teamId: se.teamId } });
  // No courier zone: a replacement the customer pays delivery for is charged
  // this order's own ৳80, so the figures below don't depend on seeded rates.
  const deliveryCharge = 80;
  const totals = computeOrderTotals([{ qty, unitPrice: 1450, lineDiscount: 100 }], deliveryCharge);
  const order = await tx.order.create({
    data: {
      orderNo: `TEST-RX-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      channel: opts.channel ?? "ONLINE",
      status: "CONFIRMED",
      customerId: customer.id,
      deliveryCharge,
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      total: totals.total,
      dueAmount: totals.total,
      createdById: se.id,
      teamId: se.teamId,
      items: { create: [{ variantId, qty, unitPrice: 1450, lineDiscount: 100 }] },
    },
    include: { items: true },
  });
  await reserveVariantStock(tx, variantId, qty);
  const walletId = await resolvePaymentWalletId(tx, "BKASH", null);
  await tx.payment.create({ data: { orderId: order.id, amount: totals.total, method: "BKASH", walletId, receivedById: se.id, verified: true, verifiedAt: new Date(), verifiedById: admin.id } });
  await recomputeOrderDueAmount(tx, order.id);
  await packOrder(tx, { id: order.id, status: "CONFIRMED", items: order.items }, packer.id);
  let status = "PACKED" as const as "PACKED" | "HANDED_TO_COURIER" | "IN_TRANSIT" | "DELIVERED";
  for (const next of ["HANDED_TO_COURIER", "IN_TRANSIT", "DELIVERED"] as const) {
    await moveOrderStatus(tx, { id: order.id, status, items: [] }, next, admin.id);
    status = next;
  }
  return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
}

/** PRD §4.11 A, end to end: SE asks, TL approves, the replacement is packed, the item comes back Good. */
export async function runOnlineExchange(tx: Prisma.TransactionClient) {
  const catalog = await scratchCatalog(tx);
  const order = await deliveredOrder(tx, catalog.m.id);
  const [se, tl, packer] = await Promise.all([userFor(tx, PHONES.SE), userFor(tx, PHONES.TL), userFor(tx, PHONES.PACKING)]);
  const { id: caseId } = await requestReturnCase(tx, se, {
    orderId: order.id,
    type: "EXCHANGE",
    reason: "WRONG_SIZE",
    courierChargeBearer: "COMPANY",
    lines: [{ orderItemId: order.items[0].id, qty: 1, replacementVariantId: catalog.l.id }],
  });
  const decision = await decideReturnCase(tx, tl, caseId, { decision: "APPROVE" });
  const replacement = await tx.order.findUniqueOrThrow({ where: { id: decision!.replacementOrderId! }, include: { items: true } });
  await packOrder(tx, { id: replacement.id, status: "CONFIRMED", items: replacement.items }, packer.id);
  const rc = await tx.returnCase.findUniqueOrThrow({ where: { id: caseId } });
  await completeConditionCheck(tx, { inspectionId: rc.inspectionId!, lines: [{ orderItemId: order.items[0].id, goodQty: 1, damagedQty: 0 }] }, packer.id);
  return { catalog, order, replacement, caseId };
}

/** PRD §4.11 B: at the counter, one unit swapped for a pricier product (bKash for the difference), found damaged. */
export async function runCounterExchange(tx: Prisma.TransactionClient) {
  const catalog = await scratchCatalog(tx);
  const order = await deliveredOrder(tx, catalog.m.id, { qty: 2 });
  const pos = await userFor(tx, PHONES.POS);
  const cashWallet = await tx.wallet.findFirstOrThrow({ where: { type: "CASH" } });
  // Returned value: 1,450 − 50 (half the line discount) = 1,400; replacement 2,200 → 800 to pay.
  const result = await createCounterExchange(tx, { user: pos, cashWalletId: cashWallet.id, canCreateCustomer: true }, {
    orderId: order.id,
    reason: "DEFECTIVE",
    lines: [{ orderItemId: order.items[0].id, qty: 1, replacementVariantId: catalog.pricier.id, goodQty: 0, damagedQty: 1 }],
    tenders: [{ method: "BKASH", amount: 800, transactionId: `TRX${Date.now()}${Math.random().toString(36).slice(2, 6)}`.toUpperCase() }],
  });
  return { catalog, order, result };
}

/** PRD §4.11 return/refund: two units back, one Good, one Damaged. */
export async function runReturnWithDamage(tx: Prisma.TransactionClient) {
  const catalog = await scratchCatalog(tx);
  const order = await deliveredOrder(tx, catalog.m.id, { qty: 2 });
  const [se, tl, packer] = await Promise.all([userFor(tx, PHONES.SE), userFor(tx, PHONES.TL), userFor(tx, PHONES.PACKING)]);
  const { id: caseId } = await requestReturnCase(tx, se, { orderId: order.id, type: "RETURN", reason: "NOT_AS_EXPECTED", lines: [{ orderItemId: order.items[0].id, qty: 2 }] });
  await decideReturnCase(tx, tl, caseId, { decision: "APPROVE" });
  const rc = await tx.returnCase.findUniqueOrThrow({ where: { id: caseId } });
  await completeConditionCheck(tx, { inspectionId: rc.inspectionId!, lines: [{ orderItemId: order.items[0].id, goodQty: 1, damagedQty: 1 }] }, packer.id);
  return { catalog, order, caseId };
}
