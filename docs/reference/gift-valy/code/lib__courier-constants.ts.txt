// Courier & delivery constants — SPEC §7. Client-safe: no Prisma/server imports
// (used by the courier UI and by lib/courier.ts alike).

import type { OrderStatusValue } from "./order-constants";

export const SHIPMENT_STATUSES = [
  "HANDED_TO_COURIER",
  "IN_TRANSIT",
  "DELIVERED",
  "RETURNED",
] as const;

export type ShipmentStatusValue = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatusValue, string> = {
  HANDED_TO_COURIER: "Handed to courier",
  IN_TRANSIT: "In transit",
  DELIVERED: "Delivered",
  RETURNED: "Returned",
};

// The order-lifecycle stages the Courier module owns (SPEC §7). The order detail
// page hides these from its generic status buttons so courier moves only ever
// happen through a shipment (single source of truth). Values are a subset of
// OrderStatus, so they map 1:1 to ShipmentStatus.
export const COURIER_STAGE_STATUSES: OrderStatusValue[] = [
  "HANDED_TO_COURIER",
  "IN_TRANSIT",
  "DELIVERED",
  "RETURNED",
];

// Allowed next shipment statuses — a subset of ALLOWED_TRANSITIONS restricted to
// courier stages (lib/order-constants.ts). The order lifecycle re-validates the
// matching order transition, so this only shapes which buttons the UI offers.
export const SHIPMENT_NEXT_STATUSES: Record<
  ShipmentStatusValue,
  ShipmentStatusValue[]
> = {
  HANDED_TO_COURIER: ["IN_TRANSIT", "DELIVERED", "RETURNED"],
  IN_TRANSIT: ["DELIVERED", "RETURNED"],
  DELIVERED: ["RETURNED"],
  RETURNED: [],
};

// CORRECTIONS Orders §6m — the In Transit courier sub-states (the shipment's
// journey INSIDE Steadfast while the order status stays IN_TRANSIT). Drives the
// 4 sub-tabs + the Courier Status column. A shipment with no sub-state yet
// (manual entry, pre-C6 rows) renders as PENDING.
export const COURIER_STATUSES = [
  "PENDING",
  "ASSIGNED",
  "DELIVERY_APPROVAL_PENDING",
  "RETURN_APPROVAL_PENDING",
] as const;

export type CourierStatusValue = (typeof COURIER_STATUSES)[number];

export const COURIER_STATUS_LABELS: Record<CourierStatusValue, string> = {
  PENDING: "Pending",
  ASSIGNED: "Assigned",
  DELIVERY_APPROVAL_PENDING: "Delivery Approval Pending",
  RETURN_APPROVAL_PENDING: "Return Approval Pending",
};

// CORRECTIONS Orders §R2 — "Assigned" is only real once an actual rider is on
// record (name + contact). A shipment can carry courierStatus = ASSIGNED with no
// rider only from pre-fix data or a mid-write race; treat that as still Pending
// EVERYWHERE (badge, sub-tab filter, counts) so the warehouse-received state can
// never masquerade as Assigned. The two approval sub-states are independent of
// the rider and pass through untouched.
export function displayedCourierStatus(
  courierStatus: CourierStatusValue | null,
  hasRider: boolean
): CourierStatusValue {
  if (courierStatus === "ASSIGNED" && !hasRider) return "PENDING";
  return courierStatus ?? "PENDING";
}

// CORRECTIONS Orders §6n — the Returned tab's sub-tabs: Pending = the parcel is
// on its way back (no stock change yet); Received = the Packaging team took it
// in and ran the damage inspection (OK → stock, Damaged → damage log).
export const RETURN_SUB_TABS = ["pending", "received"] as const;

export type ReturnSubTabValue = (typeof RETURN_SUB_TABS)[number];

// Auto-created expense category for courier fees — the COD remittance fee and
// the return courier charge both post here (SPEC §7 / §9.1, "Courier Charge").
export const COURIER_EXPENSE_CATEGORY = "Courier Charge";

// CORRECTIONS Orders §R8 — the two REAL charge lines a paid Steadfast payout
// posts (numbers from the payment invoice, not estimates): the payable delivery
// charge total and the ~1% COD fee. Kept apart from the legacy estimated
// "Courier Charge" so net collection + these two lines always reconcile back to
// the gross COD (net + charges = gross).
export const COURIER_DELIVERY_CHARGE_EXPENSE_CATEGORY = "Courier Delivery Charge";
export const COD_CHARGE_EXPENSE_CATEGORY = "COD Charge";

// CORRECTIONS Orders §6n — damaged returns post their at-cost loss here so the
// monthly P&L counts it as a variable operating cost automatically.
export const DAMAGED_STOCK_EXPENSE_CATEGORY = "Damaged Stock";

// CORRECTIONS Orders §R6 — stuck-parcel escalation. A parcel's time in its
// current courier sub-status turns the Duration badge amber past the first
// threshold and red past the second (days). Admin-configurable on the Courier
// page (settings table); these are the code fallbacks. The "stuck" count + the
// default of the "stuck > X days" filter both use the amber threshold.
export const DEFAULT_STUCK_AMBER_DAYS = 3;
export const DEFAULT_STUCK_RED_DAYS = 5;

// Compact human duration for a millisecond span, e.g. "5d 3h", "2h 40m", "12m".
// Two significant units at most so the Duration column stays one line. Never
// negative (clock skew → "0m").
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

// Whole days elapsed since an ISO timestamp (floor). Used by the stuck filter
// and the escalation colour so both agree on "how many days".
export function daysSince(iso: string | null, now: number): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86_400_000));
}

export type StuckLevel = "none" | "amber" | "red";

// Escalation level from the time spent in the CURRENT sub-status. red wins past
// the higher threshold, amber past the lower — matching the Duration badge and
// the stuck-parcels count.
export function stuckLevel(
  currentStatusIso: string | null,
  now: number,
  amberDays: number,
  redDays: number
): StuckLevel {
  const days = daysSince(currentStatusIso, now);
  if (days >= Math.max(redDays, amberDays)) return "red";
  if (days >= amberDays) return "amber";
  return "none";
}

// CORRECTIONS Courier §1 — one zone's rate row (base + per-kg) of the 3-zone
// table. Shared by the config UI, the estimate API and applyHandover.
export interface ZoneRate {
  zone: "INSIDE_DHAKA" | "SUB_DHAKA" | "OUTSIDE_DHAKA";
  baseRate: number;
  perKgRate: number;
}

// CORRECTIONS Orders §R4 — "overcharge" alert tolerance. Steadfast's counted
// weight/charge is flagged only when it exceeds our own figure by MORE than this
// percentage, so tiny rounding differences don't cry wolf. Admin-configurable on
// the Courier page (stored in the settings table); this is the code fallback.
export const DEFAULT_OVERCHARGE_TOLERANCE_PCT = 10;

// True when `actual` (Steadfast's number) exceeds `ours` (our estimate) by more
// than `tolerancePct` %. Needs a positive baseline to compare against — with no
// estimate there is nothing to be "over". Shared by the UI and any report.
export function isOvercharged(
  ours: number | null | undefined,
  actual: number | null | undefined,
  tolerancePct: number
): boolean {
  if (ours == null || ours <= 0 || actual == null) return false;
  return actual > ours * (1 + Math.max(tolerancePct, 0) / 100);
}

// The courier cost ESTIMATE: base + per-kg × weight, rounded to paisa. Null when
// the zone has no configured rate (nothing to estimate from) — a missing weight
// just means the base rate. The webhook's actual delivery_charge later overrides
// this as courier_cost_actual; P&L prefers actual.
export function estimateCourierCost(
  rate: { baseRate: number; perKgRate: number } | null | undefined,
  weightKg: number | null | undefined
): number | null {
  if (!rate) return null;
  const cost = rate.baseRate + rate.perKgRate * Math.max(weightKg ?? 0, 0);
  return Math.round(cost * 100) / 100;
}

// Seed/reference list of couriers Gift Valy uses (SPEC §7). Free to edit in the UI.
export const COURIER_PRESETS = [
  "Steadfast",
  "Pathao",
  "RedX",
  "Sundarban",
  "Paperfly",
] as const;
