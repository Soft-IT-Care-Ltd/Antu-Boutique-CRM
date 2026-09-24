import "server-only";

import type { Prisma } from "@prisma/client";

import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import type { Db } from "@/lib/db/tx";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import type { OrderChannelValue, OrderStatusValue } from "@/lib/orders/constants";
import { WALK_IN_CUSTOMER_LABEL } from "@/lib/orders/customer";
import { RETURNABLE_ORDER_STATUSES, type ReturnCaseModeValue, type ReturnCaseStatusValue, type ReturnCaseTypeValue, type ReturnReasonValue } from "@/lib/returns/constants";
import type { CounterLookup, ExchangeReport, OrderReturnInfo, ReturnCaseView, ReturnableItem } from "@/lib/returns/types";
import { getStoreCreditBalance } from "@/lib/store-credit/ledger";

// Read side of PRD §4.11. Every list and detail is scoped through the
// ORIGINAL order (CLAUDE.md rule 6): an SE sees the returns on their own
// orders, a TL their team's. No cost reaches these views except the
// company-borne courier charge in the exchange report, which the routes
// strip for roles without product.cost.view ("companyCourierCost").

const orderScope = (user: SessionUser, extra: Prisma.OrderWhereInput = {}): Prisma.OrderWhereInput =>
  scopedWhere({ AND: [{ deletedAt: null }, extra] }, user) as Prisma.OrderWhereInput;

const CASE_VIEW_INCLUDE = {
  order: { select: { id: true, orderNo: true, status: true, channel: true, customer: { select: { name: true, phone: true } }, createdBy: { select: { name: true } } } },
  replacementOrder: { select: { id: true, orderNo: true, status: true, dueAmount: true } },
  requestedBy: { select: { id: true, name: true } },
  decidedBy: { select: { name: true } },
  cancelledBy: { select: { name: true } },
  inspection: { select: { status: true, inspectedAt: true, lines: { select: { orderItemId: true, goodQty: true, damagedQty: true } } } },
  lines: {
    select: {
      orderItemId: true,
      qty: true,
      orderItem: { select: { unitPrice: true, variant: { select: { sku: true, product: { select: { name: true } }, size: { select: { name: true } }, color: { select: { name: true, hexCode: true } } } } } },
      replacementVariant: { select: { sku: true, product: { select: { name: true } }, size: { select: { name: true } }, color: { select: { name: true, hexCode: true } } } },
    },
  },
  payments: { where: { kind: "REFUND" }, select: { amount: true, refundStatus: true } },
  storeCreditEntries: { where: { type: "ISSUED" }, select: { amount: true } },
} satisfies Prisma.ReturnCaseInclude;

type CaseRow = Prisma.ReturnCaseGetPayload<{ include: typeof CASE_VIEW_INCLUDE }>;

function toView(r: CaseRow, user: SessionUser): ReturnCaseView {
  return {
    id: r.id,
    type: r.type as ReturnCaseTypeValue,
    mode: r.mode as ReturnCaseModeValue,
    status: r.status as ReturnCaseStatusValue,
    reason: r.reason as ReturnReasonValue,
    reasonNote: r.reasonNote,
    courierChargeBearer: r.courierChargeBearer,
    order: {
      id: r.order.id,
      orderNo: r.order.orderNo,
      status: r.order.status as OrderStatusValue,
      channel: r.order.channel as OrderChannelValue,
      customerName: r.order.customer?.name ?? WALK_IN_CUSTOMER_LABEL,
      customerPhone: r.order.customer?.phone ?? null,
      salesExecutive: r.order.createdBy?.name ?? null,
    },
    replacementOrder: r.replacementOrder
      ? { id: r.replacementOrder.id, orderNo: r.replacementOrder.orderNo, status: r.replacementOrder.status as OrderStatusValue, dueAmount: r.replacementOrder.dueAmount.toString() }
      : null,
    lines: r.lines.map((l) => {
      const checked = r.inspection?.lines.find((i) => i.orderItemId === l.orderItemId);
      return {
        orderItemId: l.orderItemId,
        qty: l.qty,
        unitPrice: l.orderItem.unitPrice.toString(),
        item: { sku: l.orderItem.variant.sku, product: l.orderItem.variant.product.name, size: l.orderItem.variant.size.name, color: l.orderItem.variant.color.name, hexCode: l.orderItem.variant.color.hexCode },
        replacement: l.replacementVariant
          ? { sku: l.replacementVariant.sku, product: l.replacementVariant.product.name, size: l.replacementVariant.size.name, color: l.replacementVariant.color.name, hexCode: l.replacementVariant.color.hexCode }
          : null,
        goodQty: r.inspection?.status === "COMPLETED" ? (checked?.goodQty ?? 0) : null,
        damagedQty: r.inspection?.status === "COMPLETED" ? (checked?.damagedQty ?? 0) : null,
      };
    }),
    itemChecked: r.inspection?.status === "COMPLETED",
    checkedAt: r.inspection?.inspectedAt?.toISOString() ?? null,
    requestedBy: r.requestedBy?.name ?? null,
    requestedById: r.requestedBy?.id ?? null,
    requestedAt: r.createdAt.toISOString(),
    decidedBy: r.decidedBy?.name ?? null,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    cancelledBy: r.cancelledBy?.name ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelNote: r.cancelNote,
    completedAt: r.completedAt?.toISOString() ?? null,
    refundRequested: fromPaisa(-r.payments.filter((p) => p.refundStatus !== "REJECTED").reduce((a, p) => a + toPaisa(p.amount), 0)).toString(),
    settlement: r.settlement,
    owedAmount: r.owedAmount?.toFixed(2) ?? null,
    storeCreditIssued: fromPaisa(r.storeCreditEntries.reduce((a, e) => a + toPaisa(e.amount), 0)),
    isMine: r.requestedBy?.id === user.id,
  };
}

export type CaseTab = "requested" | "approved" | "done" | "closed";

const TAB_STATUS: Record<CaseTab, ReturnCaseStatusValue[]> = {
  requested: ["REQUESTED"],
  approved: ["APPROVED"],
  done: ["COMPLETED"],
  closed: ["REJECTED", "CANCELLED"],
};

function caseSearch(q: string | undefined): Prisma.ReturnCaseWhereInput {
  if (!q) return {};
  const phone = q.replace(/[\s-]/g, "");
  return {
    OR: [
      { order: { orderNo: { contains: q, mode: "insensitive" } } },
      { replacementOrder: { orderNo: { contains: q, mode: "insensitive" } } },
      { order: { customer: { name: { contains: q, mode: "insensitive" } } } },
      { order: { customer: { phone: { contains: phone } } } },
      { lines: { some: { orderItem: { variant: { sku: { contains: q, mode: "insensitive" } } } } } },
    ],
  };
}

export async function listReturnCases(
  db: Db,
  user: SessionUser,
  opts: { tab: CaseTab; type?: ReturnCaseTypeValue; channel?: OrderChannelValue; q?: string; page: number; pageSize: number },
): Promise<{ items: ReturnCaseView[]; total: number; counts: Record<CaseTab, number> }> {
  // The channel narrows inside the scope; it can never widen it (CLAUDE.md rule 6).
  const base: Prisma.ReturnCaseWhereInput = { order: orderScope(user, opts.channel ? { channel: opts.channel } : {}), ...(opts.type ? { type: opts.type } : {}) };
  const where: Prisma.ReturnCaseWhereInput = { AND: [base, { status: { in: TAB_STATUS[opts.tab] } }, caseSearch(opts.q)] };
  const [total, rows, ...counts] = await Promise.all([
    db.returnCase.count({ where }),
    db.returnCase.findMany({
      where,
      include: CASE_VIEW_INCLUDE,
      orderBy: opts.tab === "requested" || opts.tab === "approved" ? { createdAt: "asc" } : { updatedAt: "desc" },
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
    }),
    ...(Object.keys(TAB_STATUS) as CaseTab[]).map((tab) => db.returnCase.count({ where: { AND: [base, { status: { in: TAB_STATUS[tab] } }] } })),
  ]);
  const tabs = Object.keys(TAB_STATUS) as CaseTab[];
  return { items: rows.map((r) => toView(r, user)), total, counts: Object.fromEntries(tabs.map((t, i) => [t, counts[i]])) as Record<CaseTab, number> };
}

export async function getReturnCase(db: Db, user: SessionUser, id: string): Promise<ReturnCaseView | null> {
  const row = await db.returnCase.findFirst({ where: { id, order: orderScope(user) }, include: CASE_VIEW_INCLUDE });
  return row ? toView(row, user) : null;
}

const ITEMS_FOR_RETURN = {
  where: { unitCostSnapshot: { not: null } },
  select: {
    id: true,
    qty: true,
    returnedQty: true,
    unitPrice: true,
    lineDiscount: true,
    variantId: true,
    // P3.3 — one piece of an outfit set can come back on its own.
    setLine: { select: { name: true } },
    variant: { select: { sku: true, productId: true, product: { select: { name: true } }, size: { select: { name: true } }, color: { select: { name: true, hexCode: true } } } },
  },
} satisfies Prisma.Order$itemsArgs;

async function returnableItems(db: Db, orderId: string, items: Prisma.OrderItemGetPayload<typeof ITEMS_FOR_RETURN>[]): Promise<ReturnableItem[]> {
  const requested = await db.returnCaseLine.groupBy({ by: ["orderItemId"], where: { returnCase: { orderId, status: "REQUESTED" } }, _sum: { qty: true } });
  const pending = new Map(requested.map((r) => [r.orderItemId, r._sum.qty ?? 0]));
  return items.map((i) => ({
    orderItemId: i.id,
    variantId: i.variantId,
    productId: i.variant.productId,
    sku: i.variant.sku,
    product: i.variant.product.name,
    size: i.variant.size.name,
    color: i.variant.color.name,
    hexCode: i.variant.color.hexCode,
    qty: i.qty,
    returnedQty: i.returnedQty,
    unitPrice: i.unitPrice.toString(),
    paidPerUnit: fromPaisa(Math.round((toPaisa(i.unitPrice) * i.qty - toPaisa(i.lineDiscount)) / i.qty)),
    returnable: Math.max(0, i.qty - i.returnedQty - (pending.get(i.id) ?? 0)),
    setName: i.setLine?.name ?? null,
  }));
}

/** What the order screen shows: its returns/exchanges, what can still go back, and the exchange it came from. */
export async function getOrderReturnInfo(db: Db, user: SessionUser, orderId: string): Promise<OrderReturnInfo | null> {
  const order = await db.order.findFirst({
    where: { id: orderId, ...orderScope(user) },
    select: {
      id: true,
      status: true,
      customerId: true,
      items: ITEMS_FOR_RETURN,
      replacementFor: { select: { id: true, reason: true, reasonNote: true, mode: true, status: true, order: { select: { id: true, orderNo: true } } } },
    },
  });
  if (!order) return null;
  const cases = await db.returnCase.findMany({ where: { orderId }, include: CASE_VIEW_INCLUDE, orderBy: { createdAt: "desc" } });
  return {
    returnableStatus: RETURNABLE_ORDER_STATUSES.includes(order.status as OrderStatusValue),
    hasCustomer: order.customerId !== null,
    items: await returnableItems(db, order.id, order.items),
    cases: cases.map((c) => toView(c, user)),
    exchangedFrom: order.replacementFor
      ? {
          caseId: order.replacementFor.id,
          orderId: order.replacementFor.order.id,
          orderNo: order.replacementFor.order.orderNo,
          reason: order.replacementFor.reason as ReturnReasonValue,
          reasonNote: order.replacementFor.reasonNote,
          mode: order.replacementFor.mode as ReturnCaseModeValue,
          status: order.replacementFor.status as ReturnCaseStatusValue,
        }
      : null,
  };
}

/**
 * P3.2 counter exchange: the customer at the showroom hands over the item
 * and the receipt. Staff find that sale by its exact order number, whoever
 * sold it — the one deliberate reach past list scoping, for users who can
 * sell at the POS and create exchanges. It returns only what the exchange
 * needs: the items, what was paid per unit, and how many can come back —
 * no phone, no address, no payments, no cost.
 */
export async function lookupOrderForCounter(db: Db, orderNo: string): Promise<CounterLookup | null> {
  const order = await db.order.findFirst({
    where: { orderNo: { equals: orderNo.trim(), mode: "insensitive" }, deletedAt: null },
    select: { id: true, orderNo: true, status: true, channel: true, createdAt: true, customerId: true, customer: { select: { name: true } }, items: ITEMS_FOR_RETURN },
  });
  if (!order) return null;
  return {
    orderId: order.id,
    orderNo: order.orderNo,
    status: order.status as OrderStatusValue,
    channel: order.channel as OrderChannelValue,
    soldAt: order.createdAt.toISOString(),
    customerName: order.customer?.name ?? WALK_IN_CUSTOMER_LABEL,
    // P3.2 — store credit needs a customer; an anonymous sale asks for a phone.
    hasCustomer: order.customerId !== null,
    storeCredit: order.customerId ? await getStoreCreditBalance(db, order.customerId) : null,
    returnableStatus: RETURNABLE_ORDER_STATUSES.includes(order.status as OrderStatusValue),
    items: await returnableItems(db, order.id, order.items),
  };
}

/**
 * PRD §4.11: exchanges by reason, by product and variant and by the
 * executive who made the original sale, with the courier charge we bore
 * totalled — a garment exchanged again and again is a sizing or photo
 * problem. Counts units exchanged in cases approved (or done at the
 * counter) in the Dhaka range [from, to), cancelled and rejected ones left
 * out. Returns (refunds) are counted alongside for the same product view.
 */
export async function getExchangeReport(db: Db, user: SessionUser, from: Date, to: Date, channel?: OrderChannelValue): Promise<ExchangeReport> {
  const rows = await db.returnCase.findMany({
    where: {
      status: { in: ["APPROVED", "COMPLETED"] },
      decidedAt: { gte: from, lt: to },
      // The channel narrows inside the scope; it can never widen it (CLAUDE.md rule 6).
      order: orderScope(user, channel ? { channel } : {}),
    },
    select: {
      type: true,
      mode: true,
      reason: true,
      courierChargeBearer: true,
      courierCostExpense: { select: { amount: true, deletedAt: true } },
      order: { select: { createdById: true, createdBy: { select: { name: true } } } },
      lines: { select: { qty: true, orderItem: { select: { variantId: true, variant: { select: { sku: true, productId: true, product: { select: { name: true } }, size: { select: { name: true } }, color: { select: { name: true } } } } } } } },
    },
  });

  const reasons = new Map<ReturnReasonValue, { exchanges: number; returns: number; units: number }>();
  const products = new Map<string, { product: string; exchangedUnits: number; returnedUnits: number; variants: Map<string, { sku: string; label: string; exchangedUnits: number; returnedUnits: number }> }>();
  const staff = new Map<string, { name: string; exchanges: number; returns: number; units: number }>();
  let exchanges = 0;
  let returns = 0;
  let counter = 0;
  let companyBorne = 0;
  let companyCourierPaisa = 0;

  for (const r of rows) {
    const units = r.lines.reduce((a, l) => a + l.qty, 0);
    const isExchange = r.type === "EXCHANGE";
    if (isExchange) exchanges += 1;
    else returns += 1;
    if (r.mode === "COUNTER") counter += 1;
    if (r.courierChargeBearer === "COMPANY") companyBorne += 1;
    if (r.courierCostExpense && !r.courierCostExpense.deletedAt) companyCourierPaisa += toPaisa(r.courierCostExpense.amount);

    const reason = r.reason as ReturnReasonValue;
    const rs = reasons.get(reason) ?? { exchanges: 0, returns: 0, units: 0 };
    rs[isExchange ? "exchanges" : "returns"] += 1;
    rs.units += units;
    reasons.set(reason, rs);

    const staffKey = r.order.createdById ?? "—";
    const st = staff.get(staffKey) ?? { name: r.order.createdBy?.name ?? "—", exchanges: 0, returns: 0, units: 0 };
    st[isExchange ? "exchanges" : "returns"] += 1;
    st.units += units;
    staff.set(staffKey, st);

    for (const l of r.lines) {
      const v = l.orderItem.variant;
      const p = products.get(v.productId) ?? { product: v.product.name, exchangedUnits: 0, returnedUnits: 0, variants: new Map() };
      const pv = p.variants.get(l.orderItem.variantId) ?? { sku: v.sku, label: `${v.size.name} · ${v.color.name}`, exchangedUnits: 0, returnedUnits: 0 };
      if (isExchange) {
        p.exchangedUnits += l.qty;
        pv.exchangedUnits += l.qty;
      } else {
        p.returnedUnits += l.qty;
        pv.returnedUnits += l.qty;
      }
      p.variants.set(l.orderItem.variantId, pv);
      products.set(v.productId, p);
    }
  }

  const byUnits = <T extends { exchangedUnits: number; returnedUnits: number }>(a: T, b: T) => b.exchangedUnits + b.returnedUnits - (a.exchangedUnits + a.returnedUnits);
  return {
    totals: { exchanges, returns, counter, companyBorne, companyCourierCost: fromPaisa(companyCourierPaisa) },
    byReason: [...reasons.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.units - a.units),
    byProduct: [...products.values()]
      .map((p) => ({ product: p.product, exchangedUnits: p.exchangedUnits, returnedUnits: p.returnedUnits, variants: [...p.variants.values()].sort(byUnits) }))
      .sort(byUnits),
    byStaff: [...staff.values()].sort((a, b) => b.units - a.units),
  };
}
