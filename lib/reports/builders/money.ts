import "server-only";

import type { Prisma } from "@prisma/client";

import { effectiveCourierCost } from "@/lib/courier/cost";
import { EXPENSE_KIND_LABELS, EXPENSE_KIND_VALUES, EXPENSE_NATURE_LABELS, NON_OPERATING_EXPENSE_KINDS, type ExpenseKindValue } from "@/lib/expenses/constants";
import { toPaisa } from "@/lib/inventory/costing";
import { DELIVERY_ZONE_LABELS, PAYMENT_METHOD_LABELS, type DeliveryZoneValue } from "@/lib/orders/constants";
import { NOT_COUNTED_AS_SALE } from "@/lib/orders/list-presets";
import { getCollectionReport } from "@/lib/reports/finance";
import { getExchangeReport } from "@/lib/returns/queries";
import { RETURN_REASON_LABELS } from "@/lib/returns/constants";
import { DELIVERED_STATUSES, RETURNED_STATUSES } from "@/lib/targets/constants";
import { bump, dayLabel, dhakaDay, figure, money, taka, monthLabel, monthsIn, narrowOrders, orderScope, ratio, withQuery, type BuildContext, type BuiltReport } from "@/lib/reports/shared";
import type { ReportColumn, ReportRow } from "@/lib/reports/types";

// R6 Courier, R7 Collection, R8 Expense, R13 Exchange (PRD §4.15).

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// R6 Courier
// ---------------------------------------------------------------------------

export async function buildCourierReport(ctx: BuildContext): Promise<BuiltReport> {
  const f = ctx.filters;
  const shipments = await ctx.db.shipment.findMany({
    where: {
      bookedAt: { gte: f.from, lt: f.to },
      ...(f.courierId ? { courierId: f.courierId } : {}),
      order: orderScope(ctx.user, { deletedAt: null, ...narrowOrders(f) }),
    },
    select: {
      courier: { select: { name: true } },
      zone: true,
      bookedAt: true,
      deliveredAt: true,
      returnedAt: true,
      codAmount: true,
      codCollected: true,
      courierCostActual: true,
      courierCostEstimate: true,
      order: { select: { status: true, items: { select: { returnedQty: true } } } },
    },
  });

  type Acc = { parcels: number; delivered: number; partial: number; returned: number; onTheWay: number; days: number; daysN: number; cod: number; charges: number; chargeUnknown: number };
  const empty = (): Acc => ({ parcels: 0, delivered: 0, partial: 0, returned: 0, onTheWay: 0, days: 0, daysN: 0, cod: 0, charges: 0, chargeUnknown: 0 });
  const byCourier = new Map<string, Acc>();
  const byZone = new Map<string, Acc>();
  const total = empty();

  for (const s of shipments) {
    const status = s.order.status;
    const delivered = s.deliveredAt !== null || (DELIVERED_STATUSES as readonly string[]).includes(status);
    const returned = !delivered && (s.returnedAt !== null || (RETURNED_STATUSES as readonly string[]).includes(status));
    const partial = delivered && s.order.items.some((i) => i.returnedQty > 0);
    const cost = effectiveCourierCost(s);
    const zoneLabel = `${s.courier.name} · ${s.zone ? DELIVERY_ZONE_LABELS[s.zone as DeliveryZoneValue] : "Zone not set"}`;
    const c = byCourier.get(s.courier.name) ?? empty();
    byCourier.set(s.courier.name, c);
    const z = byZone.get(zoneLabel) ?? empty();
    byZone.set(zoneLabel, z);
    for (const a of [c, z, total]) {
      a.parcels += 1;
      if (delivered) {
        a.delivered += 1;
        a.cod += toPaisa(s.codCollected ?? s.codAmount);
        if (s.deliveredAt && s.bookedAt) {
          a.days += (s.deliveredAt.getTime() - s.bookedAt.getTime()) / DAY_MS;
          a.daysN += 1;
        }
      } else if (returned) a.returned += 1;
      else a.onTheWay += 1;
      if (partial) a.partial += 1;
      if (cost === null) a.chargeUnknown += 1;
      else a.charges += toPaisa(cost);
    }
  }

  const row = (name: string, a: Acc): ReportRow => ({
    name,
    parcels: a.parcels,
    delivered: a.delivered,
    partial: a.partial,
    returned: a.returned,
    onTheWay: a.onTheWay,
    deliveredPct: ratio(a.delivered, a.delivered + a.returned),
    returnedPct: ratio(a.returned, a.delivered + a.returned),
    avgDays: a.daysN > 0 ? (a.days / a.daysN).toFixed(1) : null,
    cod: money(a.cod),
    courierCostActual: money(a.charges),
  });
  const columns = (first: string): ReportColumn[] => [
    { key: "name", label: first },
    { key: "parcels", label: "Parcels", format: "int" },
    { key: "delivered", label: "Delivered", format: "int" },
    { key: "partial", label: "Of which partial", format: "int" },
    { key: "returned", label: "Returned", format: "int" },
    { key: "onTheWay", label: "On the way", format: "int" },
    { key: "deliveredPct", label: "Delivered %", format: "percent" },
    { key: "returnedPct", label: "Returned %", format: "percent" },
    { key: "avgDays", label: "Avg days to deliver", format: "decimal" },
    { key: "cod", label: "COD collected", format: "money" },
    { key: "courierCostActual", label: "Courier charges", format: "money", costOnly: true },
  ];

  return {
    figures: [
      figure("Parcels booked", total.parcels, "int", { href: "/courier" }),
      figure("Delivered", ratio(total.delivered, total.delivered + total.returned), "percent", { hint: `${total.delivered} delivered · ${total.returned} returned` }),
      figure("On the way", total.onTheWay, "int"),
      figure("Avg days to deliver", total.daysN > 0 ? (total.days / total.daysN).toFixed(1) : null, "decimal"),
      figure("COD collected", money(total.cod), "money"),
      figure("Courier charges", money(total.charges), "money", { costOnly: true, hint: total.chargeUnknown > 0 ? `${total.chargeUnknown} parcels with no charge known` : "actual where known, else the estimate" }),
    ],
    tables: [
      { id: "by-courier", title: "By courier", columns: columns("Courier"), rows: [...byCourier.entries()].map(([n, a]) => row(n, a)), totals: row("Total", total), empty: "No parcels booked in this period." },
      { id: "by-zone", title: "By zone", columns: columns("Courier · zone"), rows: [...byZone.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([n, a]) => row(n, a)), empty: "No parcels booked in this period." },
    ],
    notes: [
      "Parcels handed to the courier in the period, followed to where they are now. Delivered includes partial deliveries; delivered % and returned % are of the parcels with an outcome.",
      ctx.canSeeCost
        ? "Average days = from hand-over to the courier marking it delivered. Courier charges are per parcel — the courier's actual charge where it has reported one, otherwise our estimate. In the P&L they arrive once, as the expenses a reconciled courier statement posts."
        : "Average days = from hand-over to the courier marking it delivered.",
    ],
  };
}

// ---------------------------------------------------------------------------
// R7 Collection
// ---------------------------------------------------------------------------

const DUE_BUCKETS = [
  { label: "0–7 days", max: 7 },
  { label: "8–15 days", max: 15 },
  { label: "16–30 days", max: 30 },
  { label: "31–60 days", max: 60 },
  { label: "Over 60 days", max: Infinity },
];
const COD_BUCKETS = [
  { label: "0–3 days", max: 3 },
  { label: "4–7 days", max: 7 },
  { label: "8–14 days", max: 14 },
  { label: "15–30 days", max: 30 },
  { label: "Over 30 days", max: Infinity },
];

function ageBuckets(buckets: typeof DUE_BUCKETS, items: { days: number; paisa: number }[]): ReportRow[] {
  const rows = buckets.map((b) => ({ age: b.label, count: 0, paisa: 0 }));
  const all = items.reduce((a, i) => a + i.paisa, 0);
  for (const i of items) {
    const idx = buckets.findIndex((b) => i.days <= b.max);
    rows[idx].count += 1;
    rows[idx].paisa += i.paisa;
  }
  return rows.map((r) => ({ age: r.age, count: r.count, amount: money(r.paisa), share: ratio(r.paisa, all) }));
}

const IN_PROGRESS = ["CONFIRMED", "PACKED", "HANDED_TO_COURIER", "IN_TRANSIT", "ON_HOLD"];

export async function buildCollectionsReport(ctx: BuildContext): Promise<BuiltReport> {
  const f = ctx.filters;
  const now = ctx.now.getTime();
  const channel = f.channel ? { channel: f.channel } : {};
  const saleWhere: Prisma.OrderWhereInput = { deletedAt: null, exchangedFromOrderId: null, status: { notIn: NOT_COUNTED_AS_SALE }, ...channel };
  const [collection, periodOrders, dueOrders, cod] = await Promise.all([
    getCollectionReport(ctx.db, ctx.user, f.from, f.to, f.channel),
    ctx.db.order.findMany({ where: orderScope(ctx.user, { ...saleWhere, createdAt: { gte: f.from, lt: f.to } }), select: { createdAt: true, total: true, dueAmount: true } }),
    ctx.db.order.findMany({ where: orderScope(ctx.user, { ...saleWhere, dueAmount: { gt: 0 } }), select: { createdAt: true, dueAmount: true, status: true } }),
    // The COD tab's "awaiting payout" parcels (lib/courier/cod-queries.ts).
    ctx.db.shipment.findMany({
      where: { deliveredAt: { not: null }, codReceivedAt: null, order: orderScope(ctx.user, { deletedAt: null, status: { in: ["DELIVERED", "PARTIAL_DELIVERED", "COMPLETED"] }, ...channel }) },
      select: { deliveredAt: true, codAmount: true, codCollected: true },
    }),
  ]);

  const days = new Map<string, { sales: number; placed: number; due: number; collected: number; refunds: number }>();
  const dayRow = (d: string) => {
    const r = days.get(d) ?? { sales: 0, placed: 0, due: 0, collected: 0, refunds: 0 };
    days.set(d, r);
    return r;
  };
  let periodValue = 0;
  let periodDue = 0;
  for (const o of periodOrders) {
    const r = dayRow(dhakaDay(o.createdAt));
    r.sales += 1;
    r.placed += toPaisa(o.total);
    r.due += toPaisa(o.dueAmount);
    periodValue += toPaisa(o.total);
    periodDue += toPaisa(o.dueAmount);
  }
  for (const d of collection.byDay) {
    const r = dayRow(d.day);
    r.collected += toPaisa(d.collected);
    r.refunds += toPaisa(d.refunds);
  }

  const dueItems = dueOrders.map((o) => ({ days: Math.floor((now - o.createdAt.getTime()) / DAY_MS), paisa: toPaisa(o.dueAmount), inProgress: IN_PROGRESS.includes(o.status) }));
  const dueAll = dueItems.reduce((a, i) => a + i.paisa, 0);
  const dueWaiting = dueItems.filter((i) => i.inProgress).reduce((a, i) => a + i.paisa, 0);
  const codItems = cod.map((s) => ({ days: Math.floor((now - s.deliveredAt!.getTime()) / DAY_MS), paisa: toPaisa(s.codCollected ?? s.codAmount) }));
  const codAll = codItems.reduce((a, i) => a + i.paisa, 0);
  const t = collection.totals;
  const ageCols: ReportColumn[] = [
    { key: "age", label: "Age" },
    { key: "count", label: "Count", format: "int" },
    { key: "amount", label: "Amount", format: "money" },
    { key: "share", label: "Share", format: "percent" },
  ];

  return {
    figures: [
      figure("Collected", t.collected, "money", { hint: `${t.paymentCount} payments`, href: withQuery("/payments/collection", { from: f.fromDay, to: f.toDay }) }),
      figure("Refunded", t.refunds, "money"),
      figure("Net collected", t.net, "money"),
      figure("Due on the period's sales", money(periodDue), "money", { hint: `of ${taka(periodValue)} sold` }),
      figure("All money due now", money(dueAll), "money", { hint: `${dueItems.length} orders`, href: withQuery("/orders", { preset: "due", channel: f.channel }) }),
      figure("COD the courier owes", money(codAll), "money", { hint: `${codItems.length} parcels`, href: "/courier?tab=cod" }),
    ],
    tables: [
      {
        id: "by-day",
        title: "Collected vs due, by day",
        description: "Sales placed that day and what is still unpaid on them now, beside the money that came in that day (for any order).",
        columns: [
          { key: "day", label: "Day" },
          { key: "sales", label: "Sales", format: "int" },
          { key: "placed", label: "Sold", format: "money" },
          { key: "due", label: "Still due", format: "money" },
          { key: "collected", label: "Collected", format: "money" },
          { key: "refunds", label: "Refunded", format: "money" },
          { key: "net", label: "Net in", format: "money" },
        ],
        rows: [...days.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([d, r]) => ({ day: dayLabel(d), sales: r.sales, placed: money(r.placed), due: money(r.due), collected: money(r.collected), refunds: money(r.refunds), net: money(r.collected - r.refunds), _href: withQuery("/payments/history", { from: d, to: d }) })),
        totals: { day: "Total", sales: periodOrders.length, placed: money(periodValue), due: money(periodDue), collected: t.collected, refunds: t.refunds, net: t.net },
        empty: "No sales or payments in this period.",
      },
      {
        id: "by-method",
        title: "Collected by method",
        columns: [
          { key: "method", label: "Method" },
          { key: "count", label: "Payments", format: "int" },
          { key: "collected", label: "Collected", format: "money" },
          { key: "refunds", label: "Refunded", format: "money" },
        ],
        rows: collection.byMethod.map((m) => ({ method: PAYMENT_METHOD_LABELS[m.method], count: m.count, collected: m.collected, refunds: m.refunds })),
        empty: "No payments in this period.",
      },
      { id: "due-ageing", title: "Money due — ageing", description: `All sales with money still owed, by days since the order was placed. ${taka(dueWaiting)} of it is on orders not yet delivered (usually COD to collect at the door).`, columns: ageCols, rows: ageBuckets(DUE_BUCKETS, dueItems), totals: { age: "Total", count: dueItems.length, amount: money(dueAll) } },
      { id: "cod-ageing", title: "COD pending from the courier — ageing", description: "Delivered parcels whose COD the courier hasn't paid out yet, by days since delivery.", columns: ageCols, rows: ageBuckets(COD_BUCKETS, codItems), totals: { age: "Total", count: codItems.length, amount: money(codAll) } },
    ],
    notes: [
      "Collected = payments received in the period (verified or not); refunds = approved refunds. Store credit moves no money and isn't included.",
      "Ageing is as of now, whatever the date range: it's the money still outstanding today.",
    ],
  };
}

// ---------------------------------------------------------------------------
// R8 Expense
// ---------------------------------------------------------------------------

export async function buildExpenseReport(ctx: BuildContext): Promise<BuiltReport> {
  const f = ctx.filters;
  const rows = await ctx.db.expense.findMany({
    where: { deletedAt: null, expenseDate: { gte: f.from, lt: f.to }, ...(f.kind ? { category: { kind: f.kind } } : {}) },
    select: { amount: true, nature: true, expenseDate: true, category: { select: { name: true, kind: true } } },
  });
  const months = monthsIn(f.fromDay, f.toDay);
  let total = 0;
  let operating = 0;
  const kinds = new Map<ExpenseKindValue, { count: number; paisa: number; months: Map<string, number> }>();
  const cats = new Map<string, { kind: ExpenseKindValue; name: string; nature: Set<string>; count: number; paisa: number }>();
  const nature = new Map<string, Map<string, number>>();
  const monthTotal = new Map<string, number>();

  for (const e of rows) {
    const paisa = toPaisa(e.amount);
    const month = dhakaDay(e.expenseDate).slice(0, 7);
    total += paisa;
    if (!NON_OPERATING_EXPENSE_KINDS.includes(e.category.kind)) operating += paisa;
    const k = kinds.get(e.category.kind) ?? { count: 0, paisa: 0, months: new Map() };
    k.count += 1;
    k.paisa += paisa;
    bump(k.months, month, paisa);
    kinds.set(e.category.kind, k);
    const cKey = `${e.category.kind}:${e.category.name}`;
    const c = cats.get(cKey) ?? { kind: e.category.kind, name: e.category.name, nature: new Set<string>(), count: 0, paisa: 0 };
    c.count += 1;
    c.paisa += paisa;
    c.nature.add(EXPENSE_NATURE_LABELS[e.nature]);
    cats.set(cKey, c);
    const n = nature.get(e.nature) ?? new Map<string, number>();
    bump(n, month, paisa);
    nature.set(e.nature, n);
    bump(monthTotal, month, paisa);
  }
  const fixed = [...(nature.get("FIXED")?.values() ?? [])].reduce((a, n) => a + n, 0);
  const monthCols: ReportColumn[] = months.map((m) => ({ key: m, label: monthLabel(m), format: "money" }));
  const perMonth = (map: Map<string, number> | undefined) => Object.fromEntries(months.map((m) => [m, money(map?.get(m) ?? 0)]));
  const lastTwo = months.slice(-2);
  const change = (map: Map<string, number> | undefined) => (lastTwo.length === 2 ? ratio((map?.get(lastTwo[1]) ?? 0) - (map?.get(lastTwo[0]) ?? 0), map?.get(lastTwo[0]) ?? 0) : null);

  return {
    figures: [
      figure("Total expenses", money(total), "money", { hint: `${rows.length} entries`, href: withQuery("/expenses", { from: f.fromDay, to: f.toDay, kind: f.kind }) }),
      figure("Operating", money(operating), "money", { hint: "everything but supplier payments" }),
      figure("Fixed", money(fixed), "money"),
      figure("Variable", money(total - fixed), "money"),
      figure("Monthly average", money(Math.round(total / months.length)), "money"),
    ],
    tables: [
      {
        id: "by-heading",
        title: "By heading",
        columns: [
          { key: "heading", label: "Heading" },
          { key: "count", label: "Entries", format: "int" },
          { key: "amount", label: "Amount", format: "money" },
          { key: "share", label: "Share", format: "percent" },
        ],
        rows: EXPENSE_KIND_VALUES.filter((k) => kinds.has(k))
          .sort((a, b) => kinds.get(b)!.paisa - kinds.get(a)!.paisa)
          .map((k) => ({ heading: `${EXPENSE_KIND_LABELS[k]}${NON_OPERATING_EXPENSE_KINDS.includes(k) ? " (not P&L)" : ""}`, count: kinds.get(k)!.count, amount: money(kinds.get(k)!.paisa), share: ratio(kinds.get(k)!.paisa, total), _href: withQuery("/expenses", { from: f.fromDay, to: f.toDay, kind: k }) })),
        totals: { heading: "Total", count: rows.length, amount: money(total) },
        empty: "No expenses in this period.",
      },
      {
        id: "month-on-month",
        title: "Month on month",
        description: lastTwo.length === 2 ? `Change = ${monthLabel(lastTwo[1])} against ${monthLabel(lastTwo[0])}.` : undefined,
        columns: [{ key: "heading", label: "Heading" }, ...monthCols, { key: "total", label: "Total", format: "money" }, ...(lastTwo.length === 2 ? [{ key: "change", label: "Change", format: "percent" } as ReportColumn] : [])],
        rows: EXPENSE_KIND_VALUES.filter((k) => kinds.has(k)).map((k) => ({ heading: EXPENSE_KIND_LABELS[k], ...perMonth(kinds.get(k)!.months), total: money(kinds.get(k)!.paisa), change: change(kinds.get(k)!.months) })),
        totals: { heading: "Total", ...perMonth(monthTotal), total: money(total), change: change(monthTotal) },
        empty: "No expenses in this period.",
      },
      {
        id: "fixed-variable",
        title: "Fixed vs variable",
        columns: [{ key: "nature", label: "Type" }, ...monthCols, { key: "total", label: "Total", format: "money" }],
        rows: (["FIXED", "VARIABLE"] as const).map((n) => ({ nature: EXPENSE_NATURE_LABELS[n], ...perMonth(nature.get(n)), total: money([...(nature.get(n)?.values() ?? [])].reduce((a, x) => a + x, 0)) })),
      },
      {
        id: "by-category",
        title: "By category",
        columns: [
          { key: "heading", label: "Heading" },
          { key: "category", label: "Category" },
          { key: "nature", label: "Fixed / variable" },
          { key: "count", label: "Entries", format: "int" },
          { key: "amount", label: "Amount", format: "money" },
        ],
        rows: [...cats.values()].sort((a, b) => b.paisa - a.paisa).map((c) => ({ heading: EXPENSE_KIND_LABELS[c.kind], category: c.name, nature: [...c.nature].join(" / "), count: c.count, amount: money(c.paisa) })),
        empty: "No expenses in this period.",
      },
    ],
    notes: ["Product purchase (paying a supplier) is cash out, not a P&L cost — stock reaches profit as cost of goods when it's sold. The P&L's operating expenses are every other heading."],
  };
}

// ---------------------------------------------------------------------------
// R13 Exchange — the P3.2 exchange report, as a report
// ---------------------------------------------------------------------------

export async function buildExchangesReport(ctx: BuildContext): Promise<BuiltReport> {
  const f = ctx.filters;
  const r = await getExchangeReport(ctx.db, ctx.user, f.from, f.to, f.channel);
  return {
    figures: [
      figure("Exchanges", r.totals.exchanges, "int", { href: withQuery("/returns-exchanges", { view: "report" }) }),
      figure("Returns", r.totals.returns, "int"),
      figure("At the counter", r.totals.counter, "int"),
      figure("Courier paid by us", r.totals.companyBorne, "int", { hint: "exchanges where the shop bore the courier" }),
      figure("Cost borne by the shop", r.totals.companyCourierCost ?? "0.00", "money", { costOnly: true, hint: "courier charges on those exchanges" }),
    ],
    tables: [
      {
        id: "by-reason",
        title: "By reason",
        columns: [
          { key: "reason", label: "Reason" },
          { key: "exchanges", label: "Exchanges", format: "int" },
          { key: "returns", label: "Returns", format: "int" },
          { key: "units", label: "Units", format: "int" },
        ],
        rows: r.byReason.map((x) => ({ reason: RETURN_REASON_LABELS[x.reason], exchanges: x.exchanges, returns: x.returns, units: x.units })),
        empty: "No exchanges or returns in this period.",
      },
      {
        id: "by-variant",
        title: "By product and variant",
        description: "A garment exchanged again and again is usually a sizing or photo problem.",
        columns: [
          { key: "product", label: "Product" },
          { key: "variant", label: "Size · colour" },
          { key: "sku", label: "SKU" },
          { key: "exchangedUnits", label: "Exchanged", format: "int" },
          { key: "returnedUnits", label: "Returned", format: "int" },
        ],
        rows: r.byProduct.flatMap((p) => [
          { product: p.product, variant: "All", sku: "", exchangedUnits: p.exchangedUnits, returnedUnits: p.returnedUnits },
          ...p.variants.map((v) => ({ product: "", variant: v.label, sku: v.sku, exchangedUnits: v.exchangedUnits, returnedUnits: v.returnedUnits })),
        ]),
        empty: "No exchanges or returns in this period.",
      },
      {
        id: "by-person",
        title: "By sales executive",
        description: "Who made the original sale.",
        columns: [
          { key: "name", label: "Executive" },
          { key: "exchanges", label: "Exchanges", format: "int" },
          { key: "returns", label: "Returns", format: "int" },
          { key: "units", label: "Units", format: "int" },
        ],
        rows: r.byStaff.map((s) => ({ name: s.name, exchanges: s.exchanges, returns: s.returns, units: s.units })),
        empty: "No exchanges or returns in this period.",
      },
    ],
    notes: ["Cases approved (or done at the counter) in the period; rejected and cancelled ones are left out. The channel is the original sale's: a counter exchange of an online order counts as online."],
  };
}
