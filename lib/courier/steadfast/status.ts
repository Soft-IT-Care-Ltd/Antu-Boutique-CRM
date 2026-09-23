// Steadfast status/time/phone rules — pure functions, no I/O, so every rule
// here is unit-tested directly. Behaviour learned from Gift Valy's production
// traffic (docs/reference/gift-valy/STEADFAST_INTEGRATION.md §3 and
// CORRECTIONS.md Round 2 §2.5 / §2.6), rewritten for Antu's lifecycle.

import type { ShipmentSubStatusValue } from "@/lib/courier/constants";

/** The order status a Steadfast status moves the order to, or null for "no move". */
export type SteadfastTarget = "IN_TRANSIT" | "DELIVERED" | "PARTIAL_DELIVERED" | "RETURNED" | null;

export type MappedSteadfastStatus = {
  /** Exactly what Steadfast sent. */
  raw: string;
  /** Trimmed + lowercased — the webhook sends "Delivered", polling "delivered". */
  normalized: string;
  to: SteadfastTarget;
  /** undefined = leave the shipment's sub-status alone; null = clear it (final). */
  subStatus: ShipmentSubStatusValue | null | undefined;
  onHold: boolean;
  needsAttention: boolean;
  /** A FINAL courier state: the shipment can't change any more — stop polling. */
  final: boolean;
  /** False for anything outside the documented webhook + polling sets. */
  recognized: boolean;
};

/**
 * STEADFAST_INTEGRATION.md §3B mapping, case-insensitive, accepting both the
 * short webhook set and the fuller polling set. Round 2 §2.6: the
 * *_approval_pending statuses mean the rider has marked the parcel but the
 * hub hasn't approved it (COD not yet in our balance) — the order HOLDS at
 * IN_TRANSIT with that sub-status. Only the final statuses move it on:
 * delivered → DELIVERED, partial_delivered → PARTIAL_DELIVERED,
 * cancelled → RETURNED.
 */
export function mapSteadfastStatus(raw: string | null | undefined): MappedSteadfastStatus {
  const rawText = raw ?? "";
  const normalized = rawText.trim().toLowerCase();
  const base = { raw: rawText, normalized, onHold: false, needsAttention: false, final: false, recognized: true };
  switch (normalized) {
    case "in_review":
      return { ...base, to: null, subStatus: undefined };
    case "pending":
      return { ...base, to: "IN_TRANSIT", subStatus: "PENDING" };
    case "hold":
      return { ...base, to: "IN_TRANSIT", subStatus: "PENDING", onHold: true };
    case "delivered_approval_pending":
      return { ...base, to: "IN_TRANSIT", subStatus: "DELIVERY_APPROVAL_PENDING" };
    case "partial_delivered_approval_pending":
      return { ...base, to: "IN_TRANSIT", subStatus: "PARTIAL_DELIVERY_APPROVAL_PENDING" };
    case "cancelled_approval_pending":
      return { ...base, to: "IN_TRANSIT", subStatus: "RETURN_APPROVAL_PENDING" };
    case "delivered":
      return { ...base, to: "DELIVERED", subStatus: null, final: true };
    case "partial_delivered":
      return { ...base, to: "PARTIAL_DELIVERED", subStatus: null, final: true };
    case "cancelled":
      return { ...base, to: "RETURNED", subStatus: null, final: true };
    case "unknown":
    case "unknown_approval_pending":
      return { ...base, to: null, subStatus: undefined, needsAttention: true };
    default:
      // Undocumented: never acted on, always logged and flagged for a human.
      return { ...base, to: null, subStatus: undefined, needsAttention: true, recognized: false };
  }
}

/** The approval-wait status that precedes each final status. */
const APPROVAL_PENDING_FOR_FINAL: Record<string, string> = {
  delivered: "delivered_approval_pending",
  partial_delivered: "partial_delivered_approval_pending",
  cancelled: "cancelled_approval_pending",
};

export type FinalWebhookResolution = {
  /** The status to actually ingest. */
  status: string;
  /** Set when the result should be surfaced to a human (API disagreed or was unreachable). */
  attentionReason: string | null;
};

/**
 * Round 2 §2.6 — Steadfast fires the webhook's "delivered"/"cancelled" the
 * moment the RIDER marks the parcel, before hub approval. So a final-looking
 * webhook is only trusted once the status API agrees:
 *  - API says the same final status → finalize.
 *  - API says *_approval_pending → hold IN_TRANSIT with that sub-status.
 *  - API unreachable, or says something else → hold at the approval-pending
 *    stage anyway and flag it; the 15-minute poll finalizes it once the API
 *    confirms. We never move an order to DELIVERED/RETURNED on an unverified
 *    webhook (stricter than Gift Valy, which trusted the webhook on failure).
 * `apiStatus` null means the cross-check could not be made.
 */
export function resolveFinalWebhookStatus(webhookStatus: string, apiStatus: string | null, apiError?: string | null): FinalWebhookResolution {
  const hook = mapSteadfastStatus(webhookStatus);
  if (!hook.final) return { status: webhookStatus, attentionReason: null };

  const hold = APPROVAL_PENDING_FOR_FINAL[hook.normalized];
  if (apiStatus == null) {
    return { status: hold, attentionReason: `Steadfast said "${hook.normalized}" but the status API could not confirm it${apiError ? ` (${apiError})` : ""} — waiting for the next sync` };
  }
  const api = mapSteadfastStatus(apiStatus);
  if (api.normalized === hook.normalized) return { status: webhookStatus, attentionReason: null };
  if (api.normalized === hold) return { status: apiStatus, attentionReason: null };
  return { status: hold, attentionReason: `Webhook said "${hook.normalized}" but the status API says "${api.normalized}" — waiting for the next sync` };
}

// ---------- timestamps (Round 2 §2.5) ----------

/** Dhaka is UTC+6 all year (no DST), so the offset is a constant. */
const DHAKA_UTC_OFFSET_MS = 6 * 60 * 60 * 1000;

/**
 * Steadfast's zone-less "YYYY-MM-DD HH:MM:SS" strings are Asia/Dhaka LOCAL
 * time (Gift Valy saw every webhook's updated_at land exactly +6h ahead when
 * read as UTC). Parse them as Dhaka regardless of the server's TZ and return
 * the real UTC instant. Strings with an explicit zone, and epoch numbers,
 * pass through. Null when unparseable.
 */
export function parseSteadfastTimestamp(value: unknown): Date | null {
  if (value == null) return null;
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(s);
  if (m) {
    const asIfUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
    return new Date(asIfUtc - DHAKA_UTC_OFFSET_MS);
  }
  // Only strings that carry their own zone (…Z / …+06:00) are safe to hand to Date.
  if (!/(z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------- phone (STEADFAST_INTEGRATION.md §2) ----------

/**
 * Normalize to Steadfast's 11-digit 01XXXXXXXXX: strip everything but
 * digits, then a leading 00 and/or 88 country prefix. Null when the result
 * isn't a valid BD mobile (01[3-9] + 8 digits) — the caller blocks the send.
 */
export function normalizeSteadfastPhone(raw: string | null | undefined): string | null {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("88")) d = d.slice(2);
  return /^01[3-9]\d{8}$/.test(d) ? d : null;
}

// ---------- raw-payload mining ----------

/**
 * First finite numeric value under a key matching `keyPattern`, a few levels
 * deep. The documented payloads don't promise delivery_charge outside the
 * webhook, so every raw response is inspected for it (Gift Valy §6l).
 */
export function findNumericField(raw: unknown, keyPattern: RegExp): number | null {
  const seen = new Set<object>();
  function scan(node: unknown, depth: number): number | null {
    if (node == null || typeof node !== "object" || depth > 4 || seen.has(node)) return null;
    seen.add(node);
    const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v] as const) : Object.entries(node as Record<string, unknown>);
    for (const [key, value] of entries) {
      if (keyPattern.test(key) && value !== null && value !== "") {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
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

/** Anchored so it never catches cod_charge / return_charge. */
export const DELIVERY_CHARGE_KEY = /^(delivery_charge|deliverycharge|total_delivery_charge|delivery_fee)$/i;

/** A tracking link/token Steadfast might add to a response some day — preferred over the constructed URL. */
export function discoverTrackingUrl(raw: unknown): string | null {
  const text = JSON.stringify(raw ?? null);
  const m = text.match(/https?:\/\/(?:www\.)?steadfast\.com\.bd\/tl?\/[^\s"'<>\\]+/i);
  return m ? m[0] : null;
}
