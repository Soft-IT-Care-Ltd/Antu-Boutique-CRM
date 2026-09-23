import "server-only";

// ============ Steadfast HTTP client — the ONLY module that talks to Steadfast ============
//
// Every Steadfast call in the app goes through here, so tests mock exactly
// one module (vi.mock("@/lib/courier/steadfast/client")) and nothing else can
// reach the real API. V1 API: https://portal.packzy.com/api/v1, auth via
// Api-Key + Secret-Key headers. Each call has a timeout and 2 retries with
// backoff on network/5xx errors; 4xx surfaces immediately (bad keys, bad
// payload) as SteadfastApiError.
//
// SAFETY: only GET /get_balance (Test Connection / balance widget) may reach
// the real API by default. Booking consignments and status lookups are
// refused unless STEADFAST_LIVE_API=enabled — set that in production only,
// never on a developer machine, so a stray click can't book a real parcel.

const BASE_URL = "https://portal.packzy.com/api/v1";
const TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;

export type SteadfastCreds = { apiKey: string; secretKey: string };

export class SteadfastApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "SteadfastApiError";
  }
}

export class SteadfastLiveApiDisabledError extends SteadfastApiError {
  constructor(path: string) {
    super(`Steadfast live API is disabled on this server (STEADFAST_LIVE_API is not "enabled") — refused ${path}`);
    this.name = "SteadfastLiveApiDisabledError";
  }
}

function assertLiveApiAllowed(path: string) {
  if (process.env.STEADFAST_LIVE_API !== "enabled") throw new SteadfastLiveApiDisabledError(path);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function steadfastFetch<T>(creds: SteadfastCreds, path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<T> {
  const headers: Record<string, string> = {
    "Api-Key": creds.apiKey,
    "Secret-Key": creds.secretKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timer);
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      if (res.status >= 500) {
        lastErr = new SteadfastApiError(`Steadfast ${res.status} on ${path}`, res.status, json);
        if (attempt < MAX_RETRIES) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) {
        const message =
          json && typeof json === "object" && "message" in json ? String((json as { message: unknown }).message) : `Steadfast request failed (${res.status})`;
        throw new SteadfastApiError(message, res.status, json);
      }
      return json as T;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof SteadfastApiError && err.status && err.status < 500) throw err;
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await sleep(300 * (attempt + 1));
        continue;
      }
    }
  }
  throw new SteadfastApiError(`Steadfast unreachable on ${path}: ${lastErr instanceof Error ? lastErr.message : "network error"}`);
}

// ---------- balance (Test Connection + balance widget) — always allowed ----------

export async function getBalance(creds: SteadfastCreds): Promise<number> {
  const res = await steadfastFetch<{ status?: number; current_balance?: number | string }>(creds, "/get_balance", { method: "GET" });
  const balance = Number(res?.current_balance);
  if (!Number.isFinite(balance)) throw new SteadfastApiError("Steadfast returned no balance", undefined, res);
  return balance;
}

// ---------- create consignments ----------

export type CreateOrderPayload = {
  invoice: string;
  recipient_name: string;
  recipient_phone: string;
  alternative_phone?: string;
  recipient_address: string;
  cod_amount: number;
  note?: string;
  item_description?: string;
  delivery_type: 0 | 1; // 0 = home delivery
  total_lot?: number;
};

export type Consignment = { consignment_id: number | string; invoice: string; tracking_code?: string; status?: string };

/** Returns the consignment and the full raw response (logged at booking so undocumented fields stay discoverable). */
export async function createOrder(creds: SteadfastCreds, payload: CreateOrderPayload): Promise<{ consignment: Consignment; raw: unknown }> {
  assertLiveApiAllowed("/create_order");
  const res = await steadfastFetch<{ status?: number; message?: string; consignment?: Consignment }>(creds, "/create_order", {
    method: "POST",
    body: payload,
  });
  if (!res?.consignment?.consignment_id) throw new SteadfastApiError(res?.message || "Steadfast did not return a consignment", res?.status, res);
  return { consignment: res.consignment, raw: res };
}

export type BulkResultItem = {
  invoice: string;
  consignment_id?: number | string | null;
  tracking_code?: string | null;
  status: string; // "success" | "error"
  note?: string | null;
};

/**
 * 2–500 orders in one call. Gift Valy's production code sends `data` as a
 * JSON-encoded STRING of the array (not a nested array) — that is the shape
 * Steadfast's bulk endpoint accepted with real parcels.
 */
export async function createBulkOrder(creds: SteadfastCreds, payloads: CreateOrderPayload[]): Promise<{ items: BulkResultItem[]; raw: unknown }> {
  assertLiveApiAllowed("/create_order/bulk-order");
  const res = await steadfastFetch<{ status?: number; message?: string; data?: BulkResultItem[] }>(creds, "/create_order/bulk-order", {
    method: "POST",
    body: { data: JSON.stringify(payloads) },
  });
  if (!Array.isArray(res?.data)) throw new SteadfastApiError(res?.message || "Steadfast bulk create returned no data", res?.status, res);
  return { items: res.data, raw: res };
}

// ---------- status lookups (poll + webhook cross-check) ----------

export type StatusResult = { deliveryStatus: string | null; raw: unknown };

export async function statusByCid(creds: SteadfastCreds, consignmentId: string): Promise<StatusResult> {
  const path = `/status_by_cid/${encodeURIComponent(consignmentId)}`;
  assertLiveApiAllowed(path);
  const res = await steadfastFetch<{ delivery_status?: string }>(creds, path, { method: "GET" });
  return { deliveryStatus: res?.delivery_status ?? null, raw: res };
}

export async function statusByInvoice(creds: SteadfastCreds, invoice: string): Promise<StatusResult> {
  const path = `/status_by_invoice/${encodeURIComponent(invoice)}`;
  assertLiveApiAllowed(path);
  const res = await steadfastFetch<{ delivery_status?: string }>(creds, path, { method: "GET" });
  return { deliveryStatus: res?.delivery_status ?? null, raw: res };
}
