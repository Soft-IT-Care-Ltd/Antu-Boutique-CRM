// P4.4 (PRD §4.15) — the list of reports and the filters each one takes.
// Client- and server-safe: the hub and the filter bar read it, and the
// server parses the same filter names (lib/reports/filters.ts). Who may
// run which report is decided server-side only (lib/reports/access.ts).

export const REPORT_KEYS = [
  "sales",
  "leads",
  "team",
  "stock",
  "sets",
  "courier",
  "collections",
  "expense",
  "pl",
  "attendance",
  "cancellations",
  "customers",
  "exchanges",
  "channels",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export const REPORT_FILTER_KEYS = ["person", "team", "status", "channel", "category", "groupBy", "source", "courier", "kind", "stock"] as const;
export type ReportFilterKey = (typeof REPORT_FILTER_KEYS)[number];

export const GROUP_BY_VALUES = ["day", "week", "month"] as const;
export type GroupByValue = (typeof GROUP_BY_VALUES)[number];
export const GROUP_BY_LABELS: Record<GroupByValue, string> = { day: "Day", week: "Week (Sat–Fri)", month: "Month" };

export type ReportDef = {
  key: ReportKey;
  code: string;
  title: string;
  description: string;
  filters: ReportFilterKey[];
  /** Default date range: this month so far, or the last six months (month-on-month reports). */
  defaultRange: "month" | "sixMonths";
};

export const REPORTS: ReportDef[] = [
  { key: "sales", code: "R1", title: "Sales", description: "Orders and value by day, week or month, by channel, by executive and by category.", filters: ["person", "team", "status", "channel", "category", "groupBy"], defaultRange: "month" },
  { key: "leads", code: "R2", title: "Leads", description: "Leads by source and campaign, conversion rate and lost reasons.", filters: ["person", "team", "source"], defaultRange: "month" },
  { key: "team", code: "R3", title: "Team performance", description: "Per executive: leads, orders, value, delivered, returned, exchanged, conversion and target.", filters: ["person", "team", "channel"], defaultRange: "month" },
  { key: "stock", code: "R4", title: "Stock", description: "Per variant: on hand, reserved, available, value at cost, moved in the period, and the low-stock list.", filters: ["category", "stock"], defaultRange: "month" },
  { key: "sets", code: "R5", title: "Outfit-set availability", description: "Sets you can sell right now, the component that limits each, and sets sold in the period.", filters: [], defaultRange: "month" },
  { key: "courier", code: "R6", title: "Courier", description: "Parcels per courier and zone, delivered vs returned, average delivery days and courier charges.", filters: ["courier", "person", "team"], defaultRange: "month" },
  { key: "collections", code: "R7", title: "Collection", description: "Collected vs due by date, COD the courier still owes, and how old the unpaid money is.", filters: ["channel"], defaultRange: "month" },
  { key: "expense", code: "R8", title: "Expense", description: "Expenses by heading and category, fixed vs variable, month on month.", filters: ["kind"], defaultRange: "sixMonths" },
  { key: "pl", code: "R9", title: "Profit & loss", description: "Revenue, cost of goods, gross and net profit and margin, operating expenses by heading — month on month.", filters: [], defaultRange: "sixMonths" },
  { key: "attendance", code: "R10", title: "Attendance", description: "Present, late, half day, absent and leave per staff member, month by month.", filters: ["person", "team"], defaultRange: "month" },
  { key: "cancellations", code: "R11", title: "Cancelled & returned", description: "Cancellations and items that came back: reasons, counts and value lost, by executive and by product.", filters: ["person", "team", "channel", "category"], defaultRange: "month" },
  { key: "customers", code: "R12", title: "Customer", description: "Top customers by value, repeat rate, and customers flagged as a risk.", filters: ["person", "team", "channel"], defaultRange: "month" },
  { key: "exchanges", code: "R13", title: "Exchange", description: "Exchanges (and returns) by reason, by product and variant, by executive, and the cost the shop bore.", filters: ["channel"], defaultRange: "month" },
  { key: "channels", code: "R14", title: "Channel", description: "Online vs walk-in: orders, value, average order value and margin, month by month.", filters: ["person", "team"], defaultRange: "month" },
];

export const REPORT_BY_KEY = Object.fromEntries(REPORTS.map((r) => [r.key, r])) as Record<ReportKey, ReportDef>;

export const isReportKey = (k: string): k is ReportKey => (REPORT_KEYS as readonly string[]).includes(k);
