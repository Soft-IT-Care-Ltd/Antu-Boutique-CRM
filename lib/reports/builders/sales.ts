import "server-only";

import type { Prisma } from "@prisma/client";

import { toPaisa } from "@/lib/inventory/costing";
import { ORDER_CHANNEL_LABELS, ORDER_CHANNEL_VALUES, type OrderChannelValue } from "@/lib/orders/constants";
import { NOT_COUNTED_AS_SALE } from "@/lib/orders/list-presets";
import { RETURN_INSPECTION_SOURCE_LABELS } from "@/lib/courier/constants";
import { RETURN_REASON_LABELS } from "@/lib/returns/constants";
import type { ReportFilters } from "@/lib/reports/filters";
import {
  autoGroupBy,
  categoryProducts,
  dhakaDay,
  figure,
  lineValuePaisa,
  money,
  monthLabel,
  monthsIn,
  narrowOrders,
  orderScope,
  periodKey,
  periodLabel,
  periodRange,
  ratio,
  withQuery,
  type BuildContext,
  type BuiltReport,
} from "@/lib/reports/shared";
import type { ReportRow } from "@/lib/reports/types";

// R1 Sales, R14 Channel, R11 Cancelled & returned (PRD §4.15).
//
// "A sale" is the rule targets, the dashboard and the order list's
// "Counted as sales" slice all use (lib/orders/list-where.ts SALES_WHERE):
// placed in the period (Dhaka days), not LEAD / CANCELLED / RETURNED /
// REFUNDED, not deleted, and not an exchange's replacement order (the same
// sale going out again). Value is the order total, which already drops by
// anything the customer sent back. So the R1 total for a period equals the
// order list's footer for /orders?preset=sales&from=…&to=… as the same user.

/** A status that counts as a sale — or no status filter at all. */
const countsAsSale = (f: ReportFilters) => !f.status || !NOT_COUNTED_AS_SALE.includes(f.status);

/**
 * The sales in the period, narrowed by the report's filters. A status
 * filter replaces the "counted as sale" status rule. Picking a sale status
 * (Delivered, Completed…) still leaves out exchange replacements, like the
 * list's "Counted as sales" slice it links to; picking a non-sale status
 * (Cancelled, Returned…) is every order in it, like the plain status list.
 */
function salesWhere(f: ReportFilters): Prisma.OrderWhereInput {
  return {
    deletedAt: null,
    ...(countsAsSale(f) ? { exchangedFromOrderId: null } : {}),
    createdAt: { gte: f.from, lt: f.to },
    status: f.status ? f.status : { notIn: NOT_COUNTED_AS_SALE },
    ...narrowOrders(f),
  };
}

const ITEM_SELECT = {
  qty: true,
  returnedQty: true,
  unitPrice: true,
  lineDiscount: true,
  unitCostSnapshot: true,
  variant: { select: { product: { select: { id: true, name: true, categoryId: true, category: { select: { id: true, name: true, parentId: true, parent: { select: { name: true } } } } } } } },
} satisfies Prisma.OrderItemSelect;

type ItemRow = Prisma.OrderItemGetPayload<{ select: typeof ITEM_SELECT }>;

async function loadSales(ctx: BuildContext) {
  return ctx.db.order.findMany({
    where: orderScope(ctx.user, salesWhere(ctx.filters)),
    select: { id: true, createdAt: true, channel: true, status: true, total: true, dueAmount: true, createdById: true, createdBy: { select: { name: true } }, items: { select: ITEM_SELECT } },
    orderBy: { createdAt: "asc" },
  });
}

function inCategory(item: ItemRow, categoryId: string | undefined): boolean {
  if (!categoryId) return true;
  const p = item.variant.product;
  return p.categoryId === categoryId || p.category?.parentId === categoryId;
}

const categoryLabel = (item: ItemRow) => {
  const c = item.variant.product.category;
  if (!c) return "No category";
  return c.parent ? `${c.parent.name} › ${c.name}` : c.name;
};

/** The order list slice these numbers reconcile with — only when the list can apply every filter used. */
function ordersLink(f: ReportFilters, over: { from?: string; to?: string; createdById?: string | null; channel?: OrderChannelValue } = {}): string | null {
  if (f.categoryId || f.teamId) return null;
  return withQuery("/orders", {
    preset: countsAsSale(f) ? "sales" : undefined,
    status: f.status,
    channel: over.channel ?? f.channel,
    createdById: over.createdById === null ? undefined : (over.createdById ?? f.personId),
    from: over.from ?? f.fromDay,
    to: over.to ?? f.toDay,
  });
}

// ---------------------------------------------------------------------------
// R1 Sales
// ---------------------------------------------------------------------------

export async function buildSalesReport(ctx: BuildContext): Promise<BuiltReport> {
  const f = ctx.filters;
  const orders = await loadSales(ctx);
  const g = f.groupBy ?? autoGroupBy(f.fromDay, f.toDay);

  let value = 0;
  let due = 0;
  let units = 0;
  const periods = new Map<string, { orders: number; value: number; online: number; walkIn: number }>();
  const channels = new Map<OrderChannelValue, { orders: number; value: number }>();
  const people = new Map<string, { name: string; orders: number; value: number; due: number }>();
  const categories = new Map<string, { orders: Set<string>; units: number; value: number }>();

  for (const o of orders) {
    const total = toPaisa(o.total);
    value += total;
    due += toPaisa(o.dueAmount);
    const key = periodKey(dhakaDay(o.createdAt), g);
    const p = periods.get(key) ?? { orders: 0, value: 0, online: 0, walkIn: 0 };
    p.orders += 1;
    p.value += total;
    p[o.channel === "ONLINE" ? "online" : "walkIn"] += total;
    periods.set(key, p);
    const c = channels.get(o.channel) ?? { orders: 0, value: 0 };
    c.orders += 1;
    c.value += total;
    channels.set(o.channel, c);
    const personKey = o.createdById ?? "";
    const pe = people.get(personKey) ?? { name: o.createdBy?.name ?? "—", orders: 0, value: 0, due: 0 };
    pe.orders += 1;
    pe.value += total;
    pe.due += toPaisa(o.dueAmount);
    people.set(personKey, pe);
    for (const item of o.items) {
      if (!inCategory(item, f.categoryId)) continue;
      const kept = item.qty - item.returnedQty;
      units += kept;
      const label = categoryLabel(item);
      const cat = categories.get(label) ?? { orders: new Set<string>(), units: 0, value: 0 };
      if (kept > 0) cat.orders.add(o.id);
      cat.units += kept;
      cat.value += lineValuePaisa(item, kept);
      categories.set(label, cat);
    }
  }

  const count = orders.length;
  const aov = (v: number, n: number) => (n > 0 ? money(Math.round(v / n)) : null);
  const categoryValue = [...categories.values()].reduce((a, c) => a + c.value, 0);

  return {
    figures: [
      figure("Orders", count, "int", { href: ordersLink(f) ?? undefined }),
      figure("Order value", money(value), "money"),
      figure("Average order", aov(value, count), "money"),
      figure("Still due", money(due), "money", { hint: "unpaid on these orders today" }),
      figure("Units sold", units, "int", { hint: f.categoryId ? "in the category" : "kept by the customer" }),
    ],
    tables: [
      {
        id: "by-period",
        title: `By ${g === "week" ? "week" : g}`,
        columns: [
          { key: "period", label: g === "week" ? "Week" : g === "month" ? "Month" : "Day" },
          { key: "orders", label: "Orders", format: "int" },
          { key: "value", label: "Value", format: "money" },
          { key: "online", label: "Online", format: "money" },
          { key: "walkIn", label: "Walk-in", format: "money" },
          { key: "aov", label: "Avg order", format: "money" },
        ],
        rows: [...periods.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, p]) => {
            const r = periodRange(key, g, f);
            return { period: periodLabel(key, g), orders: p.orders, value: money(p.value), online: money(p.online), walkIn: money(p.walkIn), aov: aov(p.value, p.orders), _href: ordersLink(f, r) };
          }),
        totals: { period: "Total", orders: count, value: money(value), online: money(channels.get("ONLINE")?.value ?? 0), walkIn: money(channels.get("WALK_IN")?.value ?? 0), aov: aov(value, count) },
        empty: "No sales in this period.",
      },
      {
        id: "by-channel",
        title: "By channel",
        columns: [
          { key: "channel", label: "Channel" },
          { key: "orders", label: "Orders", format: "int" },
          { key: "value", label: "Value", format: "money" },
          { key: "share", label: "Share", format: "percent" },
          { key: "aov", label: "Avg order", format: "money" },
        ],
        rows: ORDER_CHANNEL_VALUES.filter((ch) => channels.has(ch)).map((ch) => {
          const c = channels.get(ch)!;
          return { channel: ORDER_CHANNEL_LABELS[ch], orders: c.orders, value: money(c.value), share: ratio(c.value, value), aov: aov(c.value, c.orders), _href: ordersLink(f, { channel: ch }) };
        }),
        empty: "No sales in this period.",
      },
      {
        id: "by-person",
        title: "By sales executive",
        description: "Whoever placed the order (a walk-in sale: whoever rang it up).",
        columns: [
          { key: "name", label: "Placed by" },
          { key: "orders", label: "Orders", format: "int" },
          { key: "value", label: "Value", format: "money" },
          { key: "share", label: "Share", format: "percent" },
          { key: "aov", label: "Avg order", format: "money" },
          { key: "due", label: "Still due", format: "money" },
        ],
        rows: [...people.entries()]
          .sort(([, a], [, b]) => b.value - a.value)
          .map(([id, p]) => ({ name: p.name, orders: p.orders, value: money(p.value), share: ratio(p.value, value), aov: aov(p.value, p.orders), due: money(p.due), _href: id ? ordersLink(f, { createdById: id }) : null })),
        empty: "No sales in this period.",
      },
      {
        id: "by-category",
        title: "By category",
        description: "Item value after line discounts, for the units the customer kept. Delivery charges and whole-order discounts aren't items, so this adds up to less than the order value.",
        columns: [
          { key: "category", label: "Category" },
          { key: "orders", label: "Orders", format: "int" },
          { key: "units", label: "Units", format: "int" },
          { key: "value", label: "Item value", format: "money" },
          { key: "share", label: "Share", format: "percent" },
        ],
        rows: [...categories.entries()]
          .sort(([, a], [, b]) => b.value - a.value)
          .map(([label, c]) => ({ category: label, orders: c.orders.size, units: c.units, value: money(c.value), share: ratio(c.value, categoryValue) })),
        totals: { category: "Total", units, value: money(categoryValue) },
        empty: "No items sold in this period.",
      },
    ],
    notes: [
      f.status
        ? countsAsSale(f)
          ? "Showing sales placed in the period that are now in the chosen status (an exchange's replacement is left out — it's the same sale going out again)."
          : "Showing every order placed in the period that is now in the chosen status."
        : "Counted as sales: orders placed in the period that aren't cancelled, fully returned or an exchange's replacement — the same orders targets count. The Orders figure opens that list.",
      ...(f.categoryId ? ["With a category picked, orders and value are for orders that contain at least one item from it."] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// R14 Channel
// ---------------------------------------------------------------------------

export async function buildChannelReport(ctx: BuildContext): Promise<BuiltReport> {
  const f = ctx.filters;
  const orders = await loadSales(ctx);
  type Acc = { orders: number; value: number; units: number; outValue: number; cogs: number };
  const empty = (): Acc => ({ orders: 0, value: 0, units: 0, outValue: 0, cogs: 0 });
  const byChannel = new Map<OrderChannelValue, Acc>();
  const byMonth = new Map<string, Map<OrderChannelValue, Acc>>();
  const total = empty();

  for (const o of orders) {
    const month = dhakaDay(o.createdAt).slice(0, 7);
    const months = byMonth.get(month) ?? new Map<OrderChannelValue, Acc>();
    byMonth.set(month, months);
    const c = byChannel.get(o.channel) ?? empty();
    byChannel.set(o.channel, c);
    const m = months.get(o.channel) ?? empty();
    months.set(o.channel, m);
    const paisa = toPaisa(o.total);
    // Margin only once the goods have left and their cost is frozen
    // (CLAUDE.md rule 3): every line snapshotted — packed, or sold at the counter.
    const out = o.items.length > 0 && o.items.every((i) => i.unitCostSnapshot !== null);
    const cogs = out ? o.items.reduce((a, i) => a + (i.qty - i.returnedQty) * toPaisa(i.unitCostSnapshot ?? 0), 0) : 0;
    const units = o.items.reduce((a, i) => a + i.qty - i.returnedQty, 0);
    for (const acc of [c, m, total]) {
      acc.orders += 1;
      acc.value += paisa;
      acc.units += units;
      if (out) {
        acc.outValue += paisa;
        acc.cogs += cogs;
      }
    }
  }

  const aov = (a: Acc) => (a.orders > 0 ? money(Math.round(a.value / a.orders)) : null);
  const row = (label: string, a: Acc, extra: ReportRow = {}): ReportRow => ({
    channel: label,
    orders: a.orders,
    value: money(a.value),
    share: ratio(a.value, total.value),
    aov: aov(a),
    units: a.units,
    outValue: money(a.outValue),
    totalCost: money(a.cogs),
    profit: money(a.outValue - a.cogs),
    margin: ratio(a.outValue - a.cogs, a.outValue),
    ...extra,
  });

  const months = monthsIn(f.fromDay, f.toDay);
  return {
    figures: [
      ...ORDER_CHANNEL_VALUES.flatMap((ch) => {
        const a = byChannel.get(ch) ?? empty();
        return [figure(`${ORDER_CHANNEL_LABELS[ch]} value`, money(a.value), "money", { hint: `${a.orders} orders · ${Math.round((ratio(a.value, total.value) ?? 0) * 100)}%` }), figure(`${ORDER_CHANNEL_LABELS[ch]} avg order`, aov(a), "money")];
      }),
      figure("Gross margin", ratio(total.outValue - total.cogs, total.outValue), "percent", { costOnly: true, hint: "orders that have left the shop" }),
    ],
    tables: [
      {
        id: "by-channel",
        title: "Online vs walk-in",
        columns: [
          { key: "channel", label: "Channel" },
          { key: "orders", label: "Orders", format: "int" },
          { key: "value", label: "Value", format: "money" },
          { key: "share", label: "Share", format: "percent" },
          { key: "aov", label: "Avg order", format: "money" },
          { key: "units", label: "Units", format: "int" },
          { key: "outValue", label: "Left the shop", format: "money", costOnly: true },
          { key: "totalCost", label: "Cost of goods", format: "money", costOnly: true },
          { key: "profit", label: "Gross profit", format: "money", costOnly: true },
          { key: "margin", label: "Margin", format: "percent", costOnly: true },
        ],
        rows: ORDER_CHANNEL_VALUES.map((ch) => row(ORDER_CHANNEL_LABELS[ch], byChannel.get(ch) ?? empty(), { _href: f.teamId ? null : withQuery("/orders", { preset: "sales", channel: ch, createdById: f.personId, from: f.fromDay, to: f.toDay }) })),
        totals: row("Total", total),
      },
      {
        id: "by-month",
        title: "Month by month",
        columns: [
          { key: "month", label: "Month" },
          { key: "onlineOrders", label: "Online orders", format: "int" },
          { key: "onlineValue", label: "Online value", format: "money" },
          { key: "onlineAov", label: "Online avg", format: "money" },
          { key: "walkInOrders", label: "Walk-in orders", format: "int" },
          { key: "walkInValue", label: "Walk-in value", format: "money" },
          { key: "walkInAov", label: "Walk-in avg", format: "money" },
          { key: "margin", label: "Margin", format: "percent", costOnly: true },
        ],
        rows: months.map((m) => {
          const map = byMonth.get(m);
          const on = map?.get("ONLINE") ?? empty();
          const wi = map?.get("WALK_IN") ?? empty();
          const outValue = on.outValue + wi.outValue;
          return { month: monthLabel(m), onlineOrders: on.orders, onlineValue: money(on.value), onlineAov: aov(on), walkInOrders: wi.orders, walkInValue: money(wi.value), walkInAov: aov(wi), margin: ratio(outValue - on.cogs - wi.cogs, outValue) };
        }),
      },
    ],
    notes: [
      "Sales placed in the period (not cancelled, fully returned or an exchange's replacement). Walk-in = showroom counter sales.",
      ...(ctx.canSeeCost ? ["Margin is worked out on the orders that have already left the shop — packed, or sold at the counter — because only then is their cost frozen. Orders still waiting to be packed have no cost yet."] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// R11 Cancelled & returned
// ---------------------------------------------------------------------------

const NO_REASON = "No reason given";

export async function buildCancellationsReport(ctx: BuildContext): Promise<BuiltReport> {
  const f = ctx.filters;
  const [cancelled, lines] = await Promise.all([
    ctx.db.order.findMany({
      where: orderScope(ctx.user, { deletedAt: null, status: "CANCELLED", statusHistory: { some: { toStatus: "CANCELLED", createdAt: { gte: f.from, lt: f.to } } }, ...narrowOrders(f) }),
      select: {
        id: true,
        orderNo: true,
        total: true,
        createdById: true,
        createdBy: { select: { name: true } },
        statusHistory: { where: { toStatus: "CANCELLED" }, orderBy: { createdAt: "desc" }, take: 1, select: { note: true } },
        items: { select: ITEM_SELECT },
      },
    }),
    // Items that physically came back: courier returns, partial deliveries
    // and customer returns. Exchanges are R13's — an exchange keeps the sale.
    ctx.db.returnInspectionLine.findMany({
      where: {
        qty: { gt: 0 },
        inspection: {
          source: { not: "EXCHANGE" },
          createdAt: { gte: f.from, lt: f.to },
          order: orderScope(ctx.user, { deletedAt: null, ...narrowOrders({ ...f, categoryId: undefined }) }),
        },
        ...(f.categoryId ? { orderItem: { variant: { product: categoryProducts(f.categoryId) } } } : {}),
      },
      select: {
        qty: true,
        inspection: { select: { id: true, source: true, orderId: true, returnCase: { select: { reason: true } }, order: { select: { createdById: true, createdBy: { select: { name: true } } } } } },
        orderItem: { select: ITEM_SELECT },
      },
    }),
  ]);

  type Reason = { type: string; reason: string; orders: Set<string>; units: number; value: number };
  const reasons = new Map<string, Reason>();
  const people = new Map<string, { name: string; cancelled: number; cancelledValue: number; returnedUnits: number; returnedValue: number }>();
  const products = new Map<string, { name: string; cancelledUnits: number; returnedUnits: number; value: number }>();
  let cancelledValue = 0;
  let returnedValue = 0;
  let returnedUnits = 0;
  const returnEvents = new Set<string>();

  const reasonBucket = (type: string, label: string): Reason => {
    const key = `${type}:${label.toLowerCase()}`;
    const r = reasons.get(key) ?? { type, reason: label, orders: new Set<string>(), units: 0, value: 0 };
    reasons.set(key, r);
    return r;
  };
  const person = (id: string | null, name: string | undefined) => {
    const key = id ?? "";
    const p = people.get(key) ?? { name: name ?? "—", cancelled: 0, cancelledValue: 0, returnedUnits: 0, returnedValue: 0 };
    people.set(key, p);
    return p;
  };
  const product = (item: ItemRow) => {
    const p = products.get(item.variant.product.id) ?? { name: item.variant.product.name, cancelledUnits: 0, returnedUnits: 0, value: 0 };
    products.set(item.variant.product.id, p);
    return p;
  };

  for (const o of cancelled) {
    const paisa = toPaisa(o.total);
    cancelledValue += paisa;
    const note = o.statusHistory[0]?.note?.trim();
    const r = reasonBucket("Cancelled", note ? note.slice(0, 120) : NO_REASON);
    r.orders.add(o.id);
    r.value += paisa;
    const pe = person(o.createdById, o.createdBy?.name);
    pe.cancelled += 1;
    pe.cancelledValue += paisa;
    for (const item of o.items) {
      if (!inCategory(item, f.categoryId)) continue;
      r.units += item.qty;
      const pr = product(item);
      pr.cancelledUnits += item.qty;
      pr.value += lineValuePaisa(item, item.qty);
    }
  }

  for (const l of lines) {
    const paisa = lineValuePaisa(l.orderItem, l.qty);
    returnedValue += paisa;
    returnedUnits += l.qty;
    returnEvents.add(l.inspection.id);
    const src = l.inspection.source;
    const label = src === "CUSTOMER_RETURN" && l.inspection.returnCase ? `${RETURN_INSPECTION_SOURCE_LABELS[src]} — ${RETURN_REASON_LABELS[l.inspection.returnCase.reason]}` : RETURN_INSPECTION_SOURCE_LABELS[src];
    const r = reasonBucket("Returned", label);
    r.orders.add(l.inspection.orderId);
    r.units += l.qty;
    r.value += paisa;
    const pe = person(l.inspection.order.createdById, l.inspection.order.createdBy?.name);
    pe.returnedUnits += l.qty;
    pe.returnedValue += paisa;
    const pr = product(l.orderItem);
    pr.returnedUnits += l.qty;
    pr.value += paisa;
  }

  return {
    figures: [
      figure("Cancelled orders", cancelled.length, "int"),
      figure("Value cancelled", money(cancelledValue), "money"),
      figure("Parcels / returns back", returnEvents.size, "int"),
      figure("Units returned", returnedUnits, "int"),
      figure("Value returned", money(returnedValue), "money"),
      figure("Total value lost", money(cancelledValue + returnedValue), "money"),
    ],
    tables: [
      {
        id: "by-reason",
        title: "By reason",
        columns: [
          { key: "type", label: "What" },
          { key: "reason", label: "Reason" },
          { key: "orders", label: "Orders", format: "int" },
          { key: "units", label: "Units", format: "int" },
          { key: "value", label: "Value lost", format: "money" },
        ],
        rows: [...reasons.values()].sort((a, b) => b.value - a.value).map((r) => ({ type: r.type, reason: r.reason, orders: r.orders.size, units: r.units, value: money(r.value) })),
        empty: "Nothing was cancelled or returned in this period.",
      },
      {
        id: "by-person",
        title: "By sales executive",
        columns: [
          { key: "name", label: "Placed by" },
          { key: "cancelled", label: "Cancelled", format: "int" },
          { key: "cancelledValue", label: "Value cancelled", format: "money" },
          { key: "returnedUnits", label: "Units returned", format: "int" },
          { key: "returnedValue", label: "Value returned", format: "money" },
          { key: "lost", label: "Total lost", format: "money" },
        ],
        rows: [...people.values()]
          .sort((a, b) => b.cancelledValue + b.returnedValue - (a.cancelledValue + a.returnedValue))
          .map((p) => ({ name: p.name, cancelled: p.cancelled, cancelledValue: money(p.cancelledValue), returnedUnits: p.returnedUnits, returnedValue: money(p.returnedValue), lost: money(p.cancelledValue + p.returnedValue) })),
        empty: "Nothing was cancelled or returned in this period.",
      },
      {
        id: "by-product",
        title: "By product",
        columns: [
          { key: "product", label: "Product" },
          { key: "cancelledUnits", label: "Units cancelled", format: "int" },
          { key: "returnedUnits", label: "Units returned", format: "int" },
          { key: "value", label: "Value lost", format: "money" },
        ],
        rows: [...products.values()].sort((a, b) => b.value - a.value).map((p) => ({ product: p.name, cancelledUnits: p.cancelledUnits, returnedUnits: p.returnedUnits, value: money(p.value) })),
        empty: "Nothing was cancelled or returned in this period.",
      },
    ],
    notes: [
      "Cancelled: orders cancelled during the period, at their order total; the reason is the note written when cancelling.",
      "Returned: items that came back during the period — a courier return, the part of a partial delivery the customer refused, or a customer return — at the price the customer paid. Exchanges are in the Exchange report (R13): the sale is kept.",
    ],
  };
}
