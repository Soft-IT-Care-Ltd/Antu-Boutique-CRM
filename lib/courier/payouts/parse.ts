import { parseSteadfastTimestamp } from "@/lib/courier/steadfast/status";
import { round2 } from "@/lib/courier/payouts/net";

// Steadfast payout payloads → plain statement data. Pure.
//
// The shape is known from Gift Valy's production capture (Round 2 §2.1):
//   list:   { status, payments: [ { payment_id: "SFC-30820783", amount (gross
//           COD), due_bills (delivery charges), charges (~1% COD fee), total
//           (net paid), status_label: "paid", created_at/ready_at/paid_at
//           "YYYY-MM-DD HH:MM:SS" Asia/Dhaka } ] }
//   detail: { payment: { …same… }, consignments: [ { consignment_id, invoice,
//           tracking_code, cod_amount, status } ] }   (no per-parcel charge)
// Still read tolerantly — a few alternative key spellings and envelopes —
// because the V1 doc doesn't promise it, and a silent parse miss was exactly
// Gift Valy's 2.1 bug ("payments: 0" forever).

export type ParsedPayout = {
  /** Their reference, verbatim ("SFC-30820783"). */
  reference: string;
  /** What GET /payments/{id} accepts: the numeric tail of the reference. */
  detailId: string;
  status: "PROCESSING" | "PAID";
  statusRaw: string | null;
  date: Date | null;
  grossAmount: number | null;
  deliveryCharge: number | null;
  codCharge: number | null;
  netAmount: number | null;
  raw: unknown;
};

export type ParsedPayoutConsignment = {
  consignmentId: string | null;
  invoice: string | null;
  codAmount: number;
  deliveryCharge: number | null;
  raw: unknown;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v != null && typeof v === "object" && !Array.isArray(v);

function first(o: Obj, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return undefined;
}
function num(o: Obj, keys: string[]): number | null {
  const v = first(o, keys);
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? round2(n) : null;
}
function str(o: Obj, keys: string[]): string | null {
  const v = first(o, keys);
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Only an explicit "money went out" state counts as PAID — anything ambiguous never moves money. */
export function normalizePayoutStatus(raw: string | null): "PROCESSING" | "PAID" {
  return /^(paid|complete|completed|success|successful|done|disbursed)$/i.test((raw ?? "").trim()) ? "PAID" : "PROCESSING";
}

function arrayIn(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isObj(raw)) return [];
  for (const k of keys) {
    const v = raw[k];
    if (Array.isArray(v)) return v;
    if (isObj(v)) {
      const inner = arrayIn(v, keys);
      if (inner.length) return inner;
    }
  }
  return [];
}

export function parsePayout(item: unknown): ParsedPayout | null {
  if (!isObj(item)) return null;
  const reference = str(item, ["payment_id", "invoice", "invoice_no", "id"]);
  if (!reference) return null;
  const tail = /(\d+)\s*$/.exec(reference)?.[1];
  if (!tail) return null;
  const statusRaw = str(item, ["status_label", "payment_status", "state"]) ?? (typeof item.status === "string" ? item.status : null);
  const dateValue = first(item, ["paid_at", "payment_date", "ready_at", "created_at"]);
  return {
    reference,
    detailId: tail,
    status: normalizePayoutStatus(statusRaw),
    statusRaw,
    date: parseSteadfastTimestamp(dateValue),
    grossAmount: num(item, ["amount", "amount_delivered", "total_cod_amount"]),
    deliveryCharge: num(item, ["due_bills", "delivery_charge", "total_delivery_charge", "payable_delivery_charge"]),
    codCharge: num(item, ["charges", "cod_charge", "total_cod_charge"]),
    netAmount: num(item, ["total", "net_amount", "net_payable", "paid_amount"]),
    raw: item,
  };
}

export function parsePayoutList(raw: unknown): ParsedPayout[] {
  return arrayIn(raw, ["payments", "data"]).map(parsePayout).filter((p): p is ParsedPayout => p !== null);
}

export function parsePayoutDetail(raw: unknown): { payout: ParsedPayout | null; consignments: ParsedPayoutConsignment[] } {
  const paymentNode = isObj(raw) ? (isObj(raw.payment) ? raw.payment : isObj(raw.data) && !Array.isArray(raw.data) ? (raw.data as Obj).payment ?? raw.data : raw) : null;
  const consignments = arrayIn(raw, ["consignments", "payment", "data"])
    .filter(isObj)
    .map((c) => ({
      consignmentId: str(c, ["consignment_id", "cid"]),
      invoice: str(c, ["invoice", "invoice_no"]),
      codAmount: num(c, ["cod_amount", "cod", "collected_amount", "amount"]) ?? 0,
      deliveryCharge: num(c, ["delivery_charge", "bill", "total_bill"]),
      raw: c,
    }))
    .filter((c) => c.consignmentId !== null || c.invoice !== null);
  return { payout: parsePayout(paymentNode), consignments };
}
