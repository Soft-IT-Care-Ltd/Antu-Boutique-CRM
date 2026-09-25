import "server-only";

import type { Prisma } from "@prisma/client";

import { scopedWhere, type ViewLevel } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import type { Db } from "@/lib/db/tx";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { formatBDT } from "@/lib/money";
import type { GroupByValue } from "@/lib/reports/catalog";
import type { ReportFilters } from "@/lib/reports/filters";
import type { ReportFigure, ReportResult, ReportTable } from "@/lib/reports/types";
import { shiftMonth } from "@/lib/targets/month";

// Helpers every report builder shares.

export type BuildContext = {
  db: Db;
  user: SessionUser;
  filters: ReportFilters;
  /** The view level of a level-scoped report (team, attendance); null otherwise. */
  level: ViewLevel | null;
  /** product.cost.view — only to leave out notes about cost; cost columns are stripped in finalize.ts regardless. */
  canSeeCost: boolean;
  now: Date;
};

export type BuiltReport = Pick<ReportResult, "figures" | "tables" | "notes"> & { period?: ReportResult["period"] };

/** An order where, AND-ed with the user's role scope last so nothing can widen it (CLAUDE.md rule 6). */
export const orderScope = (user: SessionUser, where: Prisma.OrderWhereInput): Prisma.OrderWhereInput => scopedWhere(where as Record<string, unknown>, user) as Prisma.OrderWhereInput;

/** A category and its sub-categories. */
export const categoryProducts = (categoryId: string): Prisma.ProductWhereInput => ({ OR: [{ categoryId }, { category: { parentId: categoryId } }] });

/** The person / team / channel / category filters as an order where (narrowing only). */
export function narrowOrders(f: ReportFilters): Prisma.OrderWhereInput {
  return {
    ...(f.personId ? { createdById: f.personId } : {}),
    ...(f.teamId ? { teamId: f.teamId } : {}),
    ...(f.channel ? { channel: f.channel } : {}),
    ...(f.categoryId ? { items: { some: { variant: { product: categoryProducts(f.categoryId) } } } } : {}),
  };
}

const DHAKA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" });
export const dhakaDay = (d: Date) => DHAKA_DAY.format(d);

export const money = (paisa: number) => fromPaisa(paisa);
/** Paisa as "৳ 1,42,000" — for money inside a sentence (notes, hints). */
export const taka = (paisa: number) => formatBDT(fromPaisa(paisa));
export const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

/** A line's value after its own discount, for the units the customer kept (in paisa). */
export function lineValuePaisa(item: { qty: number; unitPrice: Prisma.Decimal | string | number; lineDiscount: Prisma.Decimal | string | number }, units: number): number {
  if (item.qty <= 0) return 0;
  const full = item.qty * toPaisa(item.unitPrice) - toPaisa(item.lineDiscount);
  return Math.round((full * units) / item.qty);
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Days for a short range, weeks up to ~6 months, months beyond. */
export function autoGroupBy(fromDay: string, toDay: string): GroupByValue {
  const span = daysBetween(fromDay, toDay);
  return span <= 45 ? "day" : span <= 190 ? "week" : "month";
}

/** The bucket a Dhaka day falls in: itself, the Saturday starting its week (BD's week, Friday off), or its month. */
export function periodKey(day: string, g: GroupByValue): string {
  if (g === "day") return day;
  if (g === "month") return day.slice(0, 7);
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 1) % 7));
  return d.toISOString().slice(0, 10);
}

const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
const DAY_LABEL = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export const monthLabel = (month: string) => MONTH_LABEL.format(new Date(`${month}-01T00:00:00Z`));
export const dayLabel = (day: string) => DAY_LABEL.format(new Date(`${day}T00:00:00Z`));

export function periodLabel(key: string, g: GroupByValue): string {
  if (g === "month") return monthLabel(key);
  if (g === "week") return `Week of ${dayLabel(key)}`;
  return dayLabel(key);
}

/** The first and last Dhaka day of a bucket, clipped to the report's range. */
export function periodRange(key: string, g: GroupByValue, f: ReportFilters): { from: string; to: string } {
  let from = key;
  let to = key;
  if (g === "month") {
    from = `${key}-01`;
    to = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).toISOString().slice(0, 10);
  } else if (g === "week") {
    const d = new Date(`${key}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 6);
    to = d.toISOString().slice(0, 10);
  }
  return { from: from < f.fromDay ? f.fromDay : from, to: to > f.toDay ? f.toDay : to };
}

/** Every "YYYY-MM" the range touches, oldest first. */
export function monthsIn(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  for (let m = fromDay.slice(0, 7); m <= toDay.slice(0, 7); m = shiftMonth(m, 1)) out.push(m);
  return out;
}

export function bump<K>(map: Map<K, number>, key: K, n: number) {
  map.set(key, (map.get(key) ?? 0) + n);
}

export function withQuery(path: string, params: Record<string, string | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export const figure = (label: string, value: ReportFigure["value"], format: ReportFigure["format"], extra: Partial<ReportFigure> = {}): ReportFigure => ({ label, value, format, ...extra });

export const table = (t: ReportTable): ReportTable => t;
