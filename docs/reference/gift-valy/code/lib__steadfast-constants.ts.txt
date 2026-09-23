// Steadfast integration constants — STEADFAST_INTEGRATION.md §2 / §3.
// Client-safe: no Prisma/server imports (used by the mapper, the API client,
// the send flow and the UI alike).

import type {
  CourierStatusValue,
  ShipmentStatusValue,
} from "./courier-constants";

export const STEADFAST_COURIER_NAME = "Steadfast";

// The target ShipmentStatus a Steadfast status maps to, or null when the status
// carries no order/shipment status change (in_review / partial / unknown).
export type SteadfastTargetStatus = Extract<
  ShipmentStatusValue,
  "IN_TRANSIT" | "DELIVERED" | "RETURNED"
> | null;

export interface MappedSteadfastStatus {
  raw: string; // exactly what Steadfast sent
  normalized: string; // lowercased/trimmed for matching
  to: SteadfastTargetStatus; // shipment/order status to move to (null = no move)
  // CORRECTIONS Orders §6m — the In Transit sub-state this status implies
  // (null = leave the shipment's current sub-state untouched).
  courierStatus: CourierStatusValue | null;
  onHold: boolean; // set shipment.on_hold (§3B hold → ⚠ in courier report)
  needsAttention: boolean; // set shipment.needs_attention (unknown/partial/unrecognized)
  recognized: boolean; // false = status not in the documented set (still logged)
}

// §3B mapping table — case-INSENSITIVE (doc lists lowercase; webhook example
// sends "Delivered"). Accepts BOTH the shorter webhook set and the fuller V1
// polling set (in_review, hold, *_approval_pending) per the note in §3.
//
// CORRECTIONS Orders §6m — the *_approval_pending statuses do NOT move the
// order any more: the rider has delivered/returned the parcel but the hub
// manager hasn't approved (COD not yet in our balance), so the order stays
// IN_TRANSIT under the matching sub-tab. Only the FINAL approval statuses
// (delivered / cancelled) move the order to Delivered / Returned.
//
// PARTIAL and "unknown" have no Gift Valy order/shipment status, so they never
// transition — they only raise needs_attention for manual review (§3B), keeping
// the order lifecycle enum untouched.
export function mapSteadfastStatus(raw: string): MappedSteadfastStatus {
  const normalized = (raw ?? "").trim().toLowerCase();
  const base: Omit<
    MappedSteadfastStatus,
    "to" | "courierStatus" | "onHold" | "needsAttention" | "recognized"
  > = {
    raw,
    normalized,
  };
  switch (normalized) {
    case "in_review":
      return { ...base, to: null, courierStatus: null, onHold: false, needsAttention: false, recognized: true };
    case "pending":
      // Parcel received at the Steadfast warehouse — the §6m auto-entry moment.
      return { ...base, to: "IN_TRANSIT", courierStatus: "PENDING", onHold: false, needsAttention: false, recognized: true };
    case "hold":
      return { ...base, to: "IN_TRANSIT", courierStatus: "PENDING", onHold: true, needsAttention: false, recognized: true };
    case "delivered":
      return { ...base, to: "DELIVERED", courierStatus: null, onHold: false, needsAttention: false, recognized: true };
    case "delivered_approval_pending":
      return { ...base, to: "IN_TRANSIT", courierStatus: "DELIVERY_APPROVAL_PENDING", onHold: false, needsAttention: false, recognized: true };
    case "partial_delivered":
      // No PARTIAL status in the lifecycle — flag for Accounts manual review.
      return { ...base, to: null, courierStatus: null, onHold: false, needsAttention: true, recognized: true };
    case "partial_delivered_approval_pending":
      // Approval-wait for a partial delivery — surfaces under the delivery
      // approval sub-tab AND keeps the manual-review flag.
      return { ...base, to: "IN_TRANSIT", courierStatus: "DELIVERY_APPROVAL_PENDING", onHold: false, needsAttention: true, recognized: true };
    case "cancelled":
      return { ...base, to: "RETURNED", courierStatus: null, onHold: false, needsAttention: false, recognized: true };
    case "cancelled_approval_pending":
      return { ...base, to: "IN_TRANSIT", courierStatus: "RETURN_APPROVAL_PENDING", onHold: false, needsAttention: false, recognized: true };
    case "unknown":
    case "unknown_approval_pending":
      return { ...base, to: null, courierStatus: null, onHold: false, needsAttention: true, recognized: true };
    default:
      // Anything undocumented is never acted on, but is logged and flagged.
      return { ...base, to: null, courierStatus: null, onHold: false, needsAttention: true, recognized: false };
  }
}

// A Steadfast status is "final" once the shipment can no longer change — stop
// polling it (§3B). Since C6, *_approval_pending is NOT final: the shipment
// still awaits the hub manager, so polling continues until the true terminal
// status (delivered / cancelled / partial_delivered) lands.
export function isFinalSteadfastStatus(normalized: string): boolean {
  const n = normalized.trim().toLowerCase();
  return n === "delivered" || n === "cancelled" || n === "partial_delivered";
}

// CORRECTIONS Round 2 §2.6 — Steadfast fires the webhook's "delivered" /
// "cancelled" the moment the RIDER marks the parcel (verified in production:
// the delivered webhook lands the same second as the tracking page's
// "marked as delivered by rider" event), while hub approval — the moment the
// COD actually enters our Steadfast balance — may still be pending. The status
// API distinguishes the two (delivered_approval_pending vs delivered), so on a
// final-looking webhook the caller cross-checks the API and this helper picks
// which status to ingest: the API's approval-wait wins (the order holds
// In Transit under the approval sub-tab); anything else — agreement, a lagging
// earlier status, or no API answer — trusts the webhook as before.
export function resolveFinalWebhookStatus(
  webhookStatus: string,
  apiStatus: string | null | undefined
): string {
  if (!apiStatus) return webhookStatus;
  const hook = mapSteadfastStatus(webhookStatus);
  if (hook.to !== "DELIVERED" && hook.to !== "RETURNED") return webhookStatus;
  const api = mapSteadfastStatus(apiStatus);
  return api.courierStatus === "DELIVERY_APPROVAL_PENDING" ||
    api.courierStatus === "RETURN_APPROVAL_PENDING"
    ? apiStatus
    : webhookStatus;
}

// ---------- Steadfast timestamps (CORRECTIONS Round 2 §2.5) ----------

// Dhaka is UTC+6 year-round (no DST), so the offset is a constant.
export const DHAKA_UTC_OFFSET_MS = 6 * 60 * 60 * 1000;

// Steadfast's zone-less "YYYY-MM-DD HH:MM:SS" strings (webhook updated_at,
// /payments created_at/ready_at/paid_at) are Asia/Dhaka LOCAL time — verified
// in production, where every webhook's updated_at ran exactly +6h ahead of its
// arrival clock. `new Date()` would read them in the server's zone (UTC on the
// VPS), skewing every stored time +6h. Parse them as Dhaka → real UTC Date.
// Strings that carry an explicit zone (the consignment payloads' ISO "…Z")
// and epoch numbers pass through unchanged. Returns null when unparseable.
export function parseSteadfastTimestamp(
  value: unknown
): Date | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(s);
  if (m) {
    const utcAsWritten = Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] ?? 0)
    );
    return new Date(utcAsWritten - DHAKA_UTC_OFFSET_MS);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Normalize a phone to an 11-digit Bangladesh number 01XXXXXXXXX (§2 mapping
// rule): strip a leading 00 / 88 country prefix and all non-digits. Returns null
// when it is not a valid BD mobile number — the caller blocks the send (§2, and
// acceptance test #4: 10-digit phone → blocked).
export function normalizeBdPhone(raw: string | null | undefined): string | null {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("88")) d = d.slice(2);
  return /^01\d{9}$/.test(d) ? d : null;
}

// ---------- public tracking link (CORRECTIONS Orders §6k/§6l) ----------

// Steadfast's public tracking page. Verified against steadfast.com.bd: the
// tracking form resolves both /t/{code} and /tl/{token} links (their frontend's
// resolveCode regex is /\/t(?:l)?\/([^/?&#\s]+)/) and the page itself calls
// GET /tl/{token} with Accept: application/json — so the constructed link works
// for tracking_code-based lookups and doubles as our server-side JSON source.
export const STEADFAST_TRACKING_BASE = "https://steadfast.com.bd/tl/";

export function trackingUrlFromCode(
  trackingCode: string | null | undefined
): string | null {
  const code = trackingCode?.trim();
  return code ? `${STEADFAST_TRACKING_BASE}${encodeURIComponent(code)}` : null;
}

// The documented create-order response carries only consignment_id +
// tracking_code, but §6l says: log the FULL raw response and, if a tracking
// link/token field ever shows up, prefer it. This scans any raw payload
// (objects/arrays, a few levels deep) for such a field — a full URL under a
// *track*-named key, any /t/… or /tl/… steadfast link in a string value, or a
// bare token under a key like public_tracking_token.
export function discoverTrackingUrl(raw: unknown): string | null {
  const seen = new Set<object>();
  function scan(node: unknown, depth: number): string | null {
    if (node == null || depth > 4) return null;
    if (typeof node === "string") {
      const m = node.match(
        /https?:\/\/(?:www\.)?steadfast\.com\.bd\/t(?:l)?\/[^\s"'<>]+/i
      );
      return m ? m[0] : null;
    }
    if (typeof node !== "object") return null;
    if (seen.has(node as object)) return null;
    seen.add(node as object);
    const entries = Array.isArray(node)
      ? node.map((v, i) => [String(i), v] as const)
      : Object.entries(node as Record<string, unknown>);
    // Pass 1: keys that look like a tracking link/token.
    for (const [key, value] of entries) {
      if (typeof value !== "string" || !value.trim()) continue;
      if (!/track/i.test(key)) continue;
      if (/link|url/i.test(key)) {
        const v = value.trim();
        return /^https?:\/\//i.test(v) ? v : `${STEADFAST_TRACKING_BASE}${v}`;
      }
      if (/token/i.test(key)) return `${STEADFAST_TRACKING_BASE}${value.trim()}`;
    }
    // Pass 2: any nested value containing a steadfast tracking URL.
    for (const [, value] of entries) {
      const found = scan(value, depth + 1);
      if (found) return found;
    }
    return null;
  }
  return scan(raw, 0);
}

// §6l — the documented payloads don't promise delivery_charge/weight outside the
// webhook, so every raw API response is also inspected for them. Finds the first
// numeric value under a matching key (a few levels deep), e.g. delivery_charge,
// weight, parcel_weight.
export function findNumericField(
  raw: unknown,
  keyPattern: RegExp
): number | null {
  const seen = new Set<object>();
  function scan(node: unknown, depth: number): number | null {
    if (node == null || typeof node !== "object" || depth > 4) return null;
    if (seen.has(node as object)) return null;
    seen.add(node as object);
    const entries = Array.isArray(node)
      ? node.map((v, i) => [String(i), v] as const)
      : Object.entries(node as Record<string, unknown>);
    for (const [key, value] of entries) {
      if (keyPattern.test(key)) {
        const n = Number(value);
        if (value !== null && value !== "" && Number.isFinite(n)) return n;
      }
    }
    for (const [, value] of entries) {
      const found = scan(value, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  return scan(raw, 0);
}

// CORRECTIONS Orders §R3 — the delivery charge is not in the documented status
// API, but it surfaces (under slightly different names) in create/status
// responses and the public tracking JSON. Match every spelling Steadfast has
// been seen to use, case-insensitively; anchored so it never catches
// `cod_charge` / `return_charge`.
export const DELIVERY_CHARGE_KEY =
  /^(delivery_charge|deliverycharge|total_delivery_charge|delivery_fee|charge)$/i;
export const WEIGHT_KEY = /^(weight|parcel_weight|weight_kg)$/i;

// CORRECTIONS Orders §6m — rider name/contact are NOT in the documented API,
// but "if a webhook/API response turns out to carry rider info, prefer that":
// every raw payload is scanned for a rider-shaped object ({ rider: { name,
// phone } } — the shape the public tracking JSON uses) or flat rider_name /
// rider_phone-style keys, a few levels deep.
export interface RiderInfo {
  name: string;
  phone: string | null;
}

const RIDER_OBJECT_KEY = /^(rider|delivery_man|deliveryman|assigned_to)$/i;
const RIDER_NAME_KEY = /^(rider|delivery_man|deliveryman)_?name$/i;
const RIDER_PHONE_KEY = /^(rider|delivery_man|deliveryman)_?(phone|contact|mobile|number)$/i;

export function findRiderInfo(raw: unknown): RiderInfo | null {
  const seen = new Set<object>();
  function scan(node: unknown, depth: number): RiderInfo | null {
    if (node == null || typeof node !== "object" || depth > 4) return null;
    if (seen.has(node as object)) return null;
    seen.add(node as object);
    const entries = Array.isArray(node)
      ? node.map((v, i) => [String(i), v] as const)
      : Object.entries(node as Record<string, unknown>);
    // Pass 1: a nested rider object with name/phone fields.
    for (const [key, value] of entries) {
      if (!RIDER_OBJECT_KEY.test(key) || value == null || typeof value !== "object") continue;
      const o = value as Record<string, unknown>;
      const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : null;
      if (!name) continue;
      const phone =
        typeof o.phone === "string" && o.phone.trim()
          ? o.phone.trim()
          : typeof o.contact === "string" && o.contact.trim()
            ? o.contact.trim()
            : typeof o.mobile === "string" && o.mobile.trim()
              ? o.mobile.trim()
              : null;
      return { name, phone };
    }
    // Pass 2: flat rider_name / rider_phone keys on the same level.
    let name: string | null = null;
    let phone: string | null = null;
    for (const [key, value] of entries) {
      if (typeof value !== "string" || !value.trim()) continue;
      if (RIDER_NAME_KEY.test(key)) name = value.trim();
      else if (RIDER_PHONE_KEY.test(key)) phone = value.trim();
    }
    if (name) return { name, phone };
    // Pass 3: recurse.
    for (const [, value] of entries) {
      const found = scan(value, depth + 1);
      if (found) return found;
    }
    return null;
  }
  return scan(raw, 0);
}

// CORRECTIONS Orders §R2 — the parcel counts as "assigned to a rider" ONLY when
// a REAL rider is detected: a name AND a contact number. Steadfast populates the
// rider block with a name+phone the moment a delivery agent picks the parcel up;
// a bare name with no contact is a hub/placeholder, not an assignment, and must
// NOT flip the status to Assigned. This is the single gate every capture path
// (webhook, status API, tracking page) runs through.
//
// Round 2 §2.4 — the gate also rejects PLACEHOLDERS: production tracking pages
// answer rider {name: "Unassigned", phone: "0"} before a real assignment, and
// both fields are truthy strings, so a name-and-phone check alone stored
// "Unassigned"/"0" as a rider and faked ASSIGNED. A real contact must contain
// an actual dialable number, and the name must not be an unassigned marker.
const RIDER_PLACEHOLDER_NAME = /^(unassigned|not[ _-]?assigned|n\/?a|none|-+)$/i;

export function realRider(rider: RiderInfo | null | undefined): RiderInfo | null {
  if (!rider) return null;
  const name = rider.name?.trim();
  const phone = rider.phone?.trim();
  if (!name || !phone || RIDER_PLACEHOLDER_NAME.test(name)) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7 || /^0+$/.test(digits)) return null;
  return { name, phone };
}
