import type { OrderChannelValue, OrderStatusValue } from "@/lib/orders/constants";
import type { OrderDateBasis, OrderListPreset } from "@/lib/orders/list-presets";
import type { PackingView } from "@/lib/packing/types";

// P4.3 (PRD §4.16) — "every number must be clickable through to the list
// it summarises". Each dashboard figure is computed with the same filter
// the list below applies (lib/orders/list-where.ts, the packing views, the
// payment queue…), and links there with these builders. Client-safe.

function withQuery(path: string, params: Record<string, string | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export type DayRange = { from: string; to: string };

export function ordersHref(f: { preset?: OrderListPreset; status?: OrderStatusValue; channel?: OrderChannelValue; createdById?: string; range?: DayRange; dateBy?: OrderDateBasis } = {}): string {
  return withQuery("/orders", {
    preset: f.preset,
    status: f.status,
    channel: f.channel,
    createdById: f.createdById,
    from: f.range?.from,
    to: f.range?.to,
    dateBy: f.dateBy && f.dateBy !== "placed" ? f.dateBy : undefined,
  });
}

export const leadsHref = (f: { status?: string; followUp?: "overdue" | "today"; ownerId?: string } = {}) => withQuery("/leads", f);

export const packingHref = (view: PackingView = "queue") => (view === "queue" ? "/packing" : `/packing?view=${view}`);

export const collectionHref = (range: DayRange) => withQuery("/payments/collection", range);

export const expensesHref = (range: DayRange, kind?: string) => withQuery("/expenses", { kind, ...range });

export const profitHref = (range: DayRange) => withQuery("/reports/profit", range);

export const returnsHref = (f: { view?: "requested" | "report"; type?: "RETURN" | "EXCHANGE" } = {}) => withQuery("/returns-exchanges", f);

export const targetsHref = (month?: string) => withQuery("/targets", { month });

/** YYYY-MM-DD shifted by n calendar days. */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const SHORT_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "25 Sep" for a YYYY-MM-DD. */
export const shortDay = (day: string) => SHORT_DAY.format(new Date(`${day}T00:00:00Z`));
