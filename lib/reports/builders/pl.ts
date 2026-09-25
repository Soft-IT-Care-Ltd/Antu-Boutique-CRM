import "server-only";

import { EXPENSE_KIND_LABELS, EXPENSE_KIND_VALUES, type ExpenseKindValue } from "@/lib/expenses/constants";
import { getProfitReport } from "@/lib/finance/profit";
import { toPaisa } from "@/lib/inventory/costing";
import { getStoreCreditPosition } from "@/lib/store-credit/ledger";
import { monthRange } from "@/lib/targets/month";
import { figure, money, monthLabel, monthsIn, ratio, withQuery, type BuildContext, type BuiltReport } from "@/lib/reports/shared";
import type { ReportColumn, ReportRow } from "@/lib/reports/types";

// R9 Profit & loss (PRD §4.12, §4.15) — Admin/Manager only
// (report.pl.view + product.cost.view, lib/reports/access.ts).
//
// The P&L rule, month by month:
//   revenue − COGS = gross profit
//   gross profit − operating expenses + store-credit income = net profit
//
// • Revenue and COGS come from lib/finance/profit.ts (the dashboard's
//   profit): an order counts the day its goods leave — first PACKED, or
//   the moment a walk-in sale is rung up. Revenue = the order total (already
//   net of anything returned). COGS = the frozen unit_cost_snapshot ×
//   units kept (qty − returned_qty) — never today's purchase price.
// • Operating expenses = the expenses table, every heading but Product
//   purchase (paying a supplier is cash out; stock reaches P&L as COGS).
//   Ad spend, courier charges, packaging, damage and shortages all arrive
//   here exactly once, as the expenses their source posted.
// • Store credit (a liability) touches P&L only two ways, both from the
//   store-credit ledger, never from expenses: credit that expired unspent
//   is income, and an Admin adjustment is a cost when it adds credit
//   (goodwill) or income when it takes credit away.
// • Per-order profit (with allocated ad cost and courier cost) is a
//   different view and is never summed in here.

type Month = {
  month: string;
  fromDay: string;
  toDay: string;
  ordersOut: number;
  revenue: number;
  cogs: number;
  opex: number;
  byKind: Map<ExpenseKindValue, number>;
  expired: number;
  adjusted: number;
};

const gross = (m: Pick<Month, "revenue" | "cogs">) => m.revenue - m.cogs;
const otherIncome = (m: Pick<Month, "expired" | "adjusted">) => m.expired - m.adjusted;
const net = (m: Month) => gross(m) - m.opex + otherIncome(m);

export async function buildPlReport(ctx: BuildContext): Promise<BuiltReport> {
  const f = ctx.filters;
  const months: Month[] = await Promise.all(
    monthsIn(f.fromDay, f.toDay).map(async (month) => {
      const r = monthRange(month);
      const from = r.from < f.from ? f.from : r.from;
      const to = r.to > f.to ? f.to : r.to;
      const [profit, credit] = await Promise.all([getProfitReport(ctx.db, from, to), getStoreCreditPosition(ctx.db, from, to)]);
      const lastDay = new Date(to.getTime() - 1);
      return {
        month,
        fromDay: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(from),
        toDay: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(lastDay),
        ordersOut: profit.totals.ordersOut,
        revenue: profit.totals.revenuePaisa,
        cogs: profit.totals.cogsPaisa,
        opex: profit.totals.expensesPaisa,
        byKind: new Map(profit.expensesByKind.map((e) => [e.kind, e.paisa])),
        expired: toPaisa(credit.expired),
        adjusted: toPaisa(credit.adjusted),
      };
    }),
  );

  const sum = (pick: (m: Month) => number) => months.reduce((a, m) => a + pick(m), 0);
  const total: Month = {
    month: "total",
    fromDay: f.fromDay,
    toDay: f.toDay,
    ordersOut: sum((m) => m.ordersOut),
    revenue: sum((m) => m.revenue),
    cogs: sum((m) => m.cogs),
    opex: sum((m) => m.opex),
    byKind: new Map(EXPENSE_KIND_VALUES.map((k) => [k, sum((m) => m.byKind.get(k) ?? 0)])),
    expired: sum((m) => m.expired),
    adjusted: sum((m) => m.adjusted),
  };
  const kinds = EXPENSE_KIND_VALUES.filter((k) => (total.byKind.get(k) ?? 0) !== 0);

  const monthRow = (m: Month, label: string, prev?: Month): ReportRow => ({
    month: label,
    ordersOut: m.ordersOut,
    revenue: money(m.revenue),
    cogs: money(m.cogs),
    gross: money(gross(m)),
    grossMargin: ratio(gross(m), m.revenue),
    opex: money(m.opex),
    other: money(otherIncome(m)),
    net: money(net(m)),
    netMargin: ratio(net(m), m.revenue),
    change: prev ? ratio(net(m) - net(prev), Math.abs(net(prev))) : null,
    _href: m.month === "total" ? null : withQuery("/reports/profit", { from: m.fromDay, to: m.toDay }),
  });

  const statement = (label: string, paisa: number, extra: Partial<ReportRow> = {}): ReportRow => ({ line: label, amount: money(paisa), ofRevenue: ratio(paisa, total.revenue), ...extra });
  const monthCols: ReportColumn[] = months.map((m) => ({ key: m.month, label: monthLabel(m.month), format: "money" }));
  const perMonth = (pick: (m: Month) => number) => Object.fromEntries(months.map((m) => [m.month, money(pick(m))]));

  return {
    figures: [
      figure("Revenue", money(total.revenue), "money", { hint: `${total.ordersOut} orders out` }),
      figure("Cost of goods", money(total.cogs), "money", { hint: "frozen at packing" }),
      figure("Gross profit", money(gross(total)), "money", { signed: true, hint: `${formatPct(ratio(gross(total), total.revenue))} margin` }),
      figure("Operating expenses", money(total.opex), "money", { href: withQuery("/expenses", { from: f.fromDay, to: f.toDay, kind: "OPERATING" }) }),
      figure("Net profit", money(net(total)), "money", { signed: true }),
      figure("Net margin", ratio(net(total), total.revenue), "percent"),
    ],
    tables: [
      {
        id: "statement",
        title: "Profit & loss statement",
        description: `${monthLabel(months[0].month)}${months.length > 1 ? ` – ${monthLabel(months[months.length - 1].month)}` : ""}`,
        columns: [
          { key: "line", label: "" },
          { key: "amount", label: "Amount", format: "money" },
          { key: "ofRevenue", label: "% of revenue", format: "percent" },
        ],
        rows: [
          statement("Revenue", total.revenue),
          statement("Cost of goods sold", -total.cogs),
          statement("Gross profit", gross(total), { _strong: 1 }),
          ...kinds.map((k) => statement(`  ${EXPENSE_KIND_LABELS[k]}`, -(total.byKind.get(k) ?? 0))),
          statement("Operating expenses", -total.opex, { _strong: 1 }),
          ...(total.expired !== 0 ? [statement("Store credit expired (income)", total.expired)] : []),
          ...(total.adjusted !== 0 ? [statement("Store credit adjustments", -total.adjusted)] : []),
          statement("Net profit", net(total), { _strong: 1 }),
        ],
      },
      {
        id: "month-on-month",
        title: "Month on month",
        description: "Change = net profit against the month before.",
        columns: [
          { key: "month", label: "Month" },
          { key: "ordersOut", label: "Orders out", format: "int" },
          { key: "revenue", label: "Revenue", format: "money" },
          { key: "cogs", label: "COGS", format: "money" },
          { key: "gross", label: "Gross profit", format: "money" },
          { key: "grossMargin", label: "Gross margin", format: "percent" },
          { key: "opex", label: "Operating exp.", format: "money" },
          { key: "other", label: "Store credit income", format: "money" },
          { key: "net", label: "Net profit", format: "money" },
          { key: "netMargin", label: "Net margin", format: "percent" },
          { key: "change", label: "Change", format: "percent" },
        ],
        rows: months.map((m, i) => monthRow(m, monthLabel(m.month), months[i - 1])),
        totals: monthRow(total, "Total"),
      },
      {
        id: "expenses",
        title: "Operating expenses by heading",
        columns: [{ key: "heading", label: "Heading" }, ...monthCols, { key: "total", label: "Total", format: "money" }],
        rows: kinds.map((k) => ({ heading: EXPENSE_KIND_LABELS[k], ...perMonth((m) => m.byKind.get(k) ?? 0), total: money(total.byKind.get(k) ?? 0), _href: withQuery("/expenses", { from: f.fromDay, to: f.toDay, kind: k }) })),
        totals: { heading: "Total", ...perMonth((m) => m.opex), total: money(total.opex) },
        empty: "No operating expenses in this period.",
      },
    ],
    notes: [
      "Revenue and cost of goods count when the goods leave: the day an online order is packed (its cost freezes then) or the moment a counter sale is made. Revenue is the order total, already net of anything returned; cost of goods is the frozen unit cost × units the customer kept. Cancelled and fully returned orders carry neither.",
      "Operating expenses are every expense heading except Product purchase — stock reaches profit as cost of goods, never twice. Ad spend, courier charges, packaging, damage and stock shortages each arrive once, as the expense their source posted.",
      "Store credit is a liability: credit that expired unspent is income; an Admin adjustment that adds credit is a cost, one that takes it away is income. Per-order profit (with allocated ad and courier cost) is a separate view and is not added in here.",
    ],
  };
}

function formatPct(r: number | null): string {
  return r === null ? "—" : `${(r * 100).toFixed(1)}%`;
}
