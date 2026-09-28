import "server-only";

import { z } from "zod";

import type { Db } from "@/lib/db/tx";
import { EXPENSE_KIND_LABELS, EXPENSE_KIND_VALUES, type ExpenseKindValue } from "@/lib/expenses/constants";
import { dhakaDayStartUtc, STOCK_STATUS_FILTERS, todayInDhaka, type StockStatusFilter } from "@/lib/inventory/constants";
import { LEAD_SOURCE_LABELS, LEAD_SOURCE_VALUES, type LeadSourceValue } from "@/lib/leads/constants";
import { ORDER_CHANNEL_LABELS, ORDER_CHANNEL_VALUES, ORDER_STATUS_LABELS, ORDER_STATUS_VALUES, type OrderChannelValue, type OrderStatusValue } from "@/lib/orders/constants";
import type { SessionUser } from "@/lib/auth/types";
import type { ViewLevel } from "@/lib/auth/scope";
import { peopleWhere } from "@/lib/reports/access";
import { GROUP_BY_LABELS, GROUP_BY_VALUES, type GroupByValue, type ReportDef } from "@/lib/reports/catalog";
import { shiftDay } from "@/lib/dashboard/links";
import { DATE_RANGE_PRESETS, resolveDateRange, type DateRangePreset } from "@/lib/date-range";
import { dhakaToday, shiftMonth } from "@/lib/targets/month";

// Parses a report's filters from the query string (Zod, CLAUDE.md rule 9).
// Only the filters the report declares are read; the rest are ignored.
// Filters only ever NARROW: builders AND them inside the user's scope, so
// naming another executive's id returns nothing rather than their data.

export const MAX_RANGE_DAYS = 731;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD");
const id = z.string().trim().min(1).max(50);

const schema = z.object({
  // CORRECTIONS.md item 16 — the shared date filter's preset; from/to carry a custom range.
  range: z.enum(DATE_RANGE_PRESETS).optional(),
  from: day.optional(),
  to: day.optional(),
  person: id.optional(),
  team: id.optional(),
  status: z.enum(ORDER_STATUS_VALUES).optional(),
  channel: z.enum(ORDER_CHANNEL_VALUES).optional(),
  category: id.optional(),
  groupBy: z.enum(GROUP_BY_VALUES).optional(),
  source: z.enum(LEAD_SOURCE_VALUES).optional(),
  courier: id.optional(),
  kind: z.enum(EXPENSE_KIND_VALUES).optional(),
  stock: z.enum(STOCK_STATUS_FILTERS).optional(),
});

export type ReportFilters = {
  /** The preset the range came from, when it came from one (the filter bar shows it). */
  rangePreset?: DateRangePreset;
  fromDay: string;
  toDay: string;
  /** [from, to) UTC instants covering the inclusive Dhaka days. */
  from: Date;
  to: Date;
  personId?: string;
  teamId?: string;
  status?: OrderStatusValue;
  channel?: OrderChannelValue;
  categoryId?: string;
  groupBy?: GroupByValue;
  source?: LeadSourceValue;
  courierId?: string;
  kind?: ExpenseKindValue;
  stock?: StockStatusFilter;
};

export function defaultRange(def: ReportDef, today = todayInDhaka()): { fromDay: string; toDay: string } {
  const month = today.slice(0, 7);
  return { fromDay: `${def.defaultRange === "sixMonths" ? shiftMonth(month, -5) : month}-01`, toDay: today };
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

type Parsed = { ok: true; filters: ReportFilters } | { ok: false; error: string };

/**
 * Strict for the API (a bad value is a 400); `lenient` for the page, where
 * a mistyped URL just falls back to the default.
 */
/** The first Dhaka day the shop has any order or expense on — where "All Time" starts. */
export async function reportAllTimeFrom(db: Db): Promise<string | undefined> {
  const [orders, expenses] = await Promise.all([db.order.aggregate({ _min: { createdAt: true } }), db.expense.aggregate({ _min: { expenseDate: true } })]);
  const first = [orders._min.createdAt, expenses._min.expenseDate].filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime())[0];
  return first ? dhakaToday(first) : undefined;
}

/** parseReportFilters, looking up where "All Time" starts when that's what was asked for. */
export async function parseReportRequest(db: Db, def: ReportDef, params: Record<string, string | string[] | undefined>, opts: { lenient?: boolean } = {}): Promise<Parsed> {
  const range = Array.isArray(params.range) ? params.range[0] : params.range;
  return parseReportFilters(def, params, { ...opts, allTimeFrom: range === "all" ? await reportAllTimeFrom(db) : undefined });
}

export function parseReportFilters(def: ReportDef, params: Record<string, string | string[] | undefined>, opts: { lenient?: boolean; allTimeFrom?: string } = {}): Parsed {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (value) raw[k] = value;
  }
  let data: z.infer<typeof schema>;
  if (opts.lenient) {
    data = {};
    for (const [k, field] of Object.entries(schema.shape)) {
      const r = (field as z.ZodTypeAny).safeParse(raw[k]);
      if (r.success && r.data !== undefined) (data as Record<string, unknown>)[k] = r.data;
    }
  } else {
    const r = schema.safeParse(raw);
    if (!r.success) return { ok: false, error: r.error.issues[0]?.message ?? "Invalid filter" };
    data = r.data;
  }

  const fallback = defaultRange(def);
  const preset = data.range && data.range !== "custom" ? data.range : undefined;
  if (preset === "all") {
    // Every report needs both ends: All Time runs from the first order or expense, capped below.
    data.from = opts.allTimeFrom ?? fallback.fromDay;
    data.to = todayInDhaka();
  } else if (preset) {
    const r = resolveDateRange({ preset });
    data.from = r.from;
    data.to = r.to;
  }
  let fromDay = data.from ?? fallback.fromDay;
  let toDay = data.to ?? fallback.toDay;
  if (fromDay > toDay) {
    if (!opts.lenient) return { ok: false, error: "The start date must be on or before the end date" };
    [fromDay, toDay] = [toDay, fromDay];
  }
  if (daysBetween(fromDay, toDay) >= MAX_RANGE_DAYS && preset === "all") {
    fromDay = shiftDay(toDay, -(MAX_RANGE_DAYS - 1));
  } else if (daysBetween(fromDay, toDay) >= MAX_RANGE_DAYS) {
    if (!opts.lenient) return { ok: false, error: "Pick a range of two years or less" };
    fromDay = fallback.fromDay;
    toDay = fallback.toDay;
  }

  const has = (k: (typeof def.filters)[number]) => def.filters.includes(k);
  return {
    ok: true,
    filters: {
      ...(preset ? { rangePreset: preset } : {}),
      fromDay,
      toDay,
      from: dhakaDayStartUtc(fromDay),
      to: dhakaDayStartUtc(toDay, 1),
      ...(has("person") && data.person ? { personId: data.person } : {}),
      ...(has("team") && data.team ? { teamId: data.team } : {}),
      ...(has("status") && data.status ? { status: data.status } : {}),
      ...(has("channel") && data.channel ? { channel: data.channel } : {}),
      ...(has("category") && data.category ? { categoryId: data.category } : {}),
      ...(has("groupBy") && data.groupBy ? { groupBy: data.groupBy } : {}),
      ...(has("source") && data.source ? { source: data.source } : {}),
      ...(has("courier") && data.courier ? { courierId: data.courier } : {}),
      ...(has("kind") && data.kind ? { kind: data.kind } : {}),
      ...(has("stock") && data.stock && data.stock !== "all" ? { stock: data.stock } : {}),
    },
  };
}

/** The same filters back as query-string pairs (export links, "open in list"). */
export function filtersToQuery(f: ReportFilters): Record<string, string> {
  const q: Record<string, string> = { from: f.fromDay, to: f.toDay };
  if (f.personId) q.person = f.personId;
  if (f.teamId) q.team = f.teamId;
  if (f.status) q.status = f.status;
  if (f.channel) q.channel = f.channel;
  if (f.categoryId) q.category = f.categoryId;
  if (f.groupBy) q.groupBy = f.groupBy;
  if (f.source) q.source = f.source;
  if (f.courierId) q.courier = f.courierId;
  if (f.kind) q.kind = f.kind;
  if (f.stock) q.stock = f.stock;
  return q;
}

// ---------------------------------------------------------------------------
// Dropdown options, and the labels of what's applied
// ---------------------------------------------------------------------------

export type Option = { value: string; label: string };
export type FilterOptions = Partial<Record<"person" | "team" | "status" | "channel" | "category" | "groupBy" | "source" | "courier" | "kind" | "stock", Option[]>>;

const STOCK_LABELS: Record<StockStatusFilter, string> = { all: "All", in: "In stock", low: "Low", out: "Out of stock" };

export async function filterOptions(db: Db, user: SessionUser, def: ReportDef, level: ViewLevel | null, reachLevel: ViewLevel): Promise<FilterOptions> {
  const out: FilterOptions = {};
  const has = (k: (typeof def.filters)[number]) => def.filters.includes(k);
  // An executive (or anyone who only sees their own) has no one else to pick.
  if (has("person") && reachLevel !== "own") {
    const people = await db.user.findMany({ where: peopleWhere(user, def.key, level), select: { id: true, name: true, isActive: true }, orderBy: { name: "asc" } });
    out.person = people.map((p) => ({ value: p.id, label: p.isActive ? p.name : `${p.name} (inactive)` }));
  }
  if (has("team") && reachLevel === "all") {
    const teams = await db.team.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
    out.team = teams.map((t) => ({ value: t.id, label: t.name }));
  }
  if (has("status")) out.status = ORDER_STATUS_VALUES.filter((s) => s !== "LEAD").map((s) => ({ value: s, label: ORDER_STATUS_LABELS[s] }));
  if (has("channel")) out.channel = ORDER_CHANNEL_VALUES.map((c) => ({ value: c, label: ORDER_CHANNEL_LABELS[c] }));
  if (has("category")) {
    const cats = await db.category.findMany({ select: { id: true, name: true, parent: { select: { name: true } } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
    out.category = cats.map((c) => ({ value: c.id, label: c.parent ? `${c.parent.name} › ${c.name}` : c.name }));
  }
  if (has("groupBy")) out.groupBy = GROUP_BY_VALUES.map((g) => ({ value: g, label: GROUP_BY_LABELS[g] }));
  if (has("source")) out.source = LEAD_SOURCE_VALUES.map((s) => ({ value: s, label: LEAD_SOURCE_LABELS[s] }));
  if (has("courier")) {
    const couriers = await db.courierCompany.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
    out.courier = couriers.map((c) => ({ value: c.id, label: c.name }));
  }
  if (has("kind")) out.kind = EXPENSE_KIND_VALUES.map((k) => ({ value: k, label: EXPENSE_KIND_LABELS[k] }));
  if (has("stock")) out.stock = STOCK_STATUS_FILTERS.map((s) => ({ value: s, label: STOCK_LABELS[s] }));
  return out;
}

/**
 * "Sales executive: Rima Akter", … for the export header. Names come from
 * the DB, never the URL — and only for a person or team inside the user's
 * scope: naming someone else's id narrows the report to nothing, and must
 * not print their name on it either (CLAUDE.md rule 6).
 */
export async function appliedFilters(db: Db, user: SessionUser, def: ReportDef, level: ViewLevel | null, reachLevel: ViewLevel, f: ReportFilters): Promise<{ label: string; value: string }[]> {
  const teamVisible = reachLevel === "all" || (reachLevel === "team" && f.teamId === user.teamId);
  const [person, team, category, courier] = await Promise.all([
    f.personId ? db.user.findFirst({ where: { AND: [{ id: f.personId }, peopleWhere(user, def.key, level)] }, select: { name: true } }) : null,
    f.teamId && teamVisible ? db.team.findUnique({ where: { id: f.teamId }, select: { name: true } }) : null,
    f.categoryId ? db.category.findUnique({ where: { id: f.categoryId }, select: { name: true } }) : null,
    f.courierId ? db.courierCompany.findUnique({ where: { id: f.courierId }, select: { name: true } }) : null,
  ]);
  const out: { label: string; value: string }[] = [];
  if (f.personId) out.push({ label: "Person", value: person?.name ?? "Not in your view" });
  if (f.teamId) out.push({ label: "Team", value: team?.name ?? "Not in your view" });
  if (f.status) out.push({ label: "Status", value: ORDER_STATUS_LABELS[f.status] });
  if (f.channel) out.push({ label: "Channel", value: ORDER_CHANNEL_LABELS[f.channel] });
  if (f.categoryId) out.push({ label: "Category", value: category?.name ?? "Unknown" });
  if (f.source) out.push({ label: "Source", value: LEAD_SOURCE_LABELS[f.source] });
  if (f.courierId) out.push({ label: "Courier", value: courier?.name ?? "Unknown" });
  if (f.kind) out.push({ label: "Heading", value: EXPENSE_KIND_LABELS[f.kind] });
  if (f.stock) out.push({ label: "Stock", value: STOCK_LABELS[f.stock] });
  return out;
}
