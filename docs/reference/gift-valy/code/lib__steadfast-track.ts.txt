// ============ Steadfast PUBLIC tracking page (CORRECTIONS Orders §6l) ============
//
// Server-side ONLY. Some figures (the weight Steadfast counted, rider info) are
// not in the documented V1 API — but the public tracking page shows them.
// Verified against steadfast.com.bd: the tracking SPA itself calls
// GET /tl/{token} with `Accept: application/json` and renders the returned
// { status, result: {…consignment…}, trackings: […] } — result carries weight,
// cod_amount, status, public_tracking_link, rider {name, phone} and currenthub.
// Invalid/expired links answer { status: 0, message } with HTTP 200.
//
// Be gentle (§6l): callers only fetch for shipments still missing data, cache
// via shipments.tracking_page_checked_at, and space calls out. Any failure
// (Cloudflare block, HTML instead of JSON, timeout) returns null — the UI then
// falls back to our own recorded weight with an "(ours)" marker.

import {
  DELIVERY_CHARGE_KEY,
  findNumericField,
  realRider,
} from "./steadfast-constants";

const TIMEOUT_MS = 12_000;

// A plain server fetch can trip bot protection; send ordinary browser headers.
const PAGE_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "Accept-Language": "en",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
};

export interface PublicTrackingInfo {
  weightKg: number | null;
  deliveryCharge: number | null; // §R3 — the charge Steadfast counted, if shown
  codAmount: number | null;
  publicTrackingLink: string | null; // canonical link when the payload carries one
  riderName: string | null; // "Assigned To" — real rider only (name + phone, §R2)
  riderPhone: string | null;
  currentHub: string | null;
  rawStatus: string | null;
}

// The page displays weight as KG ("4.9 KG"); guard against a grams-valued
// field slipping in (no gift parcel weighs 100+ kg).
function normalizeWeightKg(value: unknown): number | null {
  const n = Number(value);
  if (value == null || value === "" || !Number.isFinite(n) || n < 0) return null;
  const kg = n > 100 ? n / 1000 : n;
  return Math.round(kg * 1000) / 1000;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Like str(), but keeps numeric values (production pages send e.g. phone: 0 as
// a bare number) — realRider() then decides whether the digits are a real
// contact, so a numeric placeholder can never sneak past as an assignment.
function strOrNum(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return str(value);
}

// A finite non-null number, else null (blank strings / null / NaN all drop out).
function numeric(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function fetchPublicTracking(
  trackingUrl: string
): Promise<PublicTrackingInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(trackingUrl, {
      headers: PAGE_HEADERS,
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const text = await res.text();

    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // HTML came back — last-ditch regex for the displayed weight.
      const m = text.match(/([\d.]+)\s*KG/i);
      return m
        ? {
            weightKg: normalizeWeightKg(m[1]),
            deliveryCharge: null,
            codAmount: null,
            publicTrackingLink: null,
            riderName: null,
            riderPhone: null,
            currentHub: null,
            rawStatus: null,
          }
        : null;
    }

    const body = json as {
      status?: unknown;
      result?: Record<string, unknown> | null;
    };
    const result = body?.result;
    if (!result || typeof result !== "object") return null; // status 0 = invalid link

    const rider = result.rider as Record<string, unknown> | null | undefined;
    const hub = result.currenthub as Record<string, unknown> | null | undefined;
    // §R2 — only a real rider (name AND contact) counts as an assignment; a bare
    // name (hub/placeholder) is dropped so it can't flip the parcel to Assigned.
    const assigned = realRider({
      name: str(rider?.name) ?? "",
      phone:
        strOrNum(rider?.phone) ??
        strOrNum(rider?.contact) ??
        strOrNum(rider?.mobile) ??
        null,
    });
    // §R3 — the counted delivery charge. Prefer an explicit field on `result`,
    // else mine the whole payload for any delivery-charge-shaped key.
    const deliveryCharge =
      numeric(result.delivery_charge) ??
      numeric((result as { total_delivery_charge?: unknown }).total_delivery_charge) ??
      findNumericField(body, DELIVERY_CHARGE_KEY);
    return {
      weightKg: normalizeWeightKg(result.weight),
      deliveryCharge:
        deliveryCharge != null && deliveryCharge >= 0 ? deliveryCharge : null,
      codAmount: numeric(result.cod_amount),
      publicTrackingLink: str(result.public_tracking_link),
      riderName: assigned?.name ?? null,
      riderPhone: assigned?.phone ?? null,
      currentHub: str(hub?.name),
      rawStatus: str(result.status),
    };
  } catch {
    return null; // network/timeout — caller treats as "no data yet"
  } finally {
    clearTimeout(timer);
  }
}
