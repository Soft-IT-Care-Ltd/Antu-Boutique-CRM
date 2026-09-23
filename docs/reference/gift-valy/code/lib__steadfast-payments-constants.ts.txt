// Steadfast payments parsing — CORRECTIONS Orders §R8. Client-safe: no
// Prisma/server imports (shared by the sync engine, the API routes, the UI and
// the verify script).

import { parseSteadfastTimestamp } from "./steadfast-constants";
//
// The GET /payments and GET /payments/{payment_id} response shapes are NOT
// fully documented in the V1 API doc — only the invoice's business fields are
// known (Amount Delivered, Payable Delivery Charge, COD Charge, Available
// Balance, and the cleared-consignment list with per-parcel COD + bill). So
// everything here parses DEFENSIVELY: the payment array is hunted for wherever
// it lives in the envelope (data / data.data / payments / …), every field is
// matched by a tolerant key pattern, and any figure the response doesn't carry
// is derived from the reconciliation identity net + charges = gross when the
// other two sides are present. The sync engine stores the first real raw
// list/detail payloads on the payment row (raw_payload / raw_detail_payload)
// so the actual shape is captured in the DB the first time it is seen.
//
// Round 2 §2.1 — the REAL production envelope (captured 2026-07-22):
//   { status: 1, alertClass, message, payments: [ {
//       payment_id: "SFC-30820783",      // the invoice STRING, not a number
//       amount: 2200,                    // GROSS delivered COD
//       method: "Bank",
//       due_bills: 135, paid_bills: 0,   // delivery charges deducted at source
//       charges: 21,                     // the ~1% COD fee
//       total: 2044,                     // NET paid out (amount − due_bills − charges)
//       status_label: "paid",
//       created_at / ready_at / paid_at: "YYYY-MM-DD HH:MM:SS"  // Asia/Dhaka local!
//   } ] }
// 10 per page, OLDEST first, no pagination metadata; past-the-end pages answer
// an empty list. GET /payments/{id} accepts the numeric tail of payment_id and
// wraps the same fields under `payment` plus its `consignments` array
// (consignment_id, invoice, tracking_code, cod_amount, status — no per-parcel
// bill). The pre-fix parser dropped every row because pickNumber(payment_id)
// choked on the "SFC-…" string — hence the perpetual `payments: 0` sync.

export const round2 = (n: number) => Math.round(n * 100) / 100;

// The merchant panel's payment-request page — the V1 API has no payment-request
// endpoint, so the "Request Payment" button is a deep link into their panel;
// the /payments sync then picks up the resulting processing → paid record.
export const STEADFAST_PANEL_PAYMENT_REQUEST_URL =
  "https://steadfast.com.bd/user/payment-request";

export type SteadfastPaymentStatusValue = "PROCESSING" | "PAID";

export const STEADFAST_PAYMENT_STATUS_LABELS: Record<
  SteadfastPaymentStatusValue,
  string
> = {
  PROCESSING: "Processing",
  PAID: "Paid",
};

// The documented lifecycle is processing → paid. Anything that clearly says the
// money went out counts as PAID; every other/unknown state stays PROCESSING so
// no money side effect ever fires off an ambiguous status.
export function normalizeSteadfastPaymentStatus(
  raw: string | null | undefined
): SteadfastPaymentStatusValue {
  const n = (raw ?? "").trim().toLowerCase();
  if (n === "unpaid") return "PROCESSING";
  if (/^(paid|complete|completed|success|successful|done|disbursed)$/.test(n)) {
    return "PAID";
  }
  return "PROCESSING";
}

export interface ParsedSteadfastPayment {
  steadfastPaymentId: number;
  invoiceNo: string | null; // e.g. "SFC-30699149"
  statusRaw: string | null;
  status: SteadfastPaymentStatusValue;
  paymentDate: Date | null;
  amountDelivered: number | null; // GROSS per-parcel COD total
  deliveryCharge: number | null; // payable delivery charge (deducted at source)
  codCharge: number | null; // the ~1% COD fee (deducted at source)
  netAmount: number | null; // what actually reaches the bank
  availableBalance: number | null;
  parcelCount: number | null;
  raw: unknown; // this item's own raw object (stored on first sight)
}

export interface ParsedPaymentConsignment {
  consignmentId: number | null;
  invoice: string | null; // their invoice = our order_no
  codAmount: number | null; // per-parcel COD (GROSS)
  deliveryCharge: number | null; // per-parcel "bill" → courier_cost_actual
  statusRaw: string | null;
  raw: unknown;
}

// ---------- tolerant field pickers ----------

// Scan an object's own keys, then one nested level (some APIs wrap rows in
// `attributes`/`payment` envelopes) — never deeper, so a consignment list on a
// detail row can't bleed its numbers into the payment totals.
function pick(
  obj: unknown,
  keyPattern: RegExp,
  depth = 1
): unknown {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const record = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (keyPattern.test(key) && value !== null && value !== undefined && value !== "") {
      return value;
    }
  }
  if (depth > 0) {
    for (const value of Object.values(record)) {
      if (value != null && typeof value === "object" && !Array.isArray(value)) {
        const found = pick(value, keyPattern, depth - 1);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}

function pickNumber(obj: unknown, keyPattern: RegExp, depth = 1): number | null {
  const v = pick(obj, keyPattern, depth);
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickString(obj: unknown, keyPattern: RegExp, depth = 1): string | null {
  const v = pick(obj, keyPattern, depth);
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return null;
}

function pickDate(obj: unknown, keyPatterns: RegExp[]): Date | null {
  for (const pattern of keyPatterns) {
    const v = pick(obj, pattern, 0);
    if (typeof v !== "string" && typeof v !== "number") continue;
    // §2.5 — their zone-less "YYYY-MM-DD HH:MM:SS" stamps are Asia/Dhaka local.
    const d = parseSteadfastTimestamp(v);
    if (d) return d;
  }
  return null;
}

// §2.1 — payment_id arrives as the invoice string "SFC-30820783"; its numeric
// tail is the id the detail endpoint accepts (GET /payments/30820783 and
// /payments/SFC-30820783 answer identically — verified in production).
export function paymentIdNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const m = value.trim().match(/(\d+)\s*$/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

// ---------- envelope hunting ----------

// A payment-shaped object: has an id AND at least one of status / an invoice-ish
// code / a money field. Loose on purpose — the envelope shape is unknown.
const PAYMENT_ID_KEY = /^(id|payment_id|paymentid)$/i;
// status_label is the real list rows' key (§2.1); bare `status` is the
// envelope's own success flag there, but consignments still use it.
const STATUS_KEY = /^(status|payment_status|status_label|state)$/i;
const INVOICE_NO_KEY = /^(invoice|invoice_no|invoice_number|invoice_code|payment_invoice)$/i;
const MONEYISH_KEY =
  /^(amount|amount_delivered|net_amount|total_amount|payable_amount|cod_amount)$/i;

function looksLikePayment(node: unknown): boolean {
  if (node == null || typeof node !== "object" || Array.isArray(node)) return false;
  const keys = Object.keys(node as Record<string, unknown>);
  const hasId = keys.some((k) => PAYMENT_ID_KEY.test(k));
  const hasSignal = keys.some(
    (k) => STATUS_KEY.test(k) || INVOICE_NO_KEY.test(k) || MONEYISH_KEY.test(k)
  );
  return hasId && hasSignal;
}

// Find the first array of payment-shaped objects anywhere in the envelope
// (raw itself, raw.data, raw.data.data, raw.payments, …), a few levels deep.
export function findPaymentArray(raw: unknown): unknown[] {
  const seen = new Set<object>();
  function scan(node: unknown, depth: number): unknown[] | null {
    if (node == null || depth > 4) return null;
    if (Array.isArray(node)) {
      return node.length === 0 || node.some(looksLikePayment) ? node : null;
    }
    if (typeof node !== "object") return null;
    if (seen.has(node as object)) return null;
    seen.add(node as object);
    for (const value of Object.values(node as Record<string, unknown>)) {
      const found = scan(value, depth + 1);
      if (found) return found;
    }
    return null;
  }
  return scan(raw, 0) ?? [];
}

// Laravel-style pagination hints — lets the sync walk a couple of extra pages
// when the envelope advertises them, without assuming they exist.
export function findNextPage(raw: unknown): number | null {
  const current = pickNumber(raw, /^current_page$/i, 2);
  const last = pickNumber(raw, /^last_page$/i, 2);
  if (current != null && last != null && last > current) return current + 1;
  const nextUrl = pickString(raw, /^next_page_url$/i, 2);
  if (nextUrl) {
    const m = nextUrl.match(/[?&]page=(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

// ---------- list-item / detail parsing ----------

// §2.5 — paid_at is the actual payout moment; ready_at (invoice ready) beats
// the request-time created_at when paid_at is absent (an unpaid invoice).
const PAYMENT_DATE_KEYS = [
  /^paid_at$/i,
  /^payment_date$/i,
  /^ready_at$/i,
  /^date$/i,
  /^created_at$/i,
];
// §2.1 real keys first (amount / due_bills / charges / total), the older
// documented/guessed spellings kept as fallbacks.
const AMOUNT_DELIVERED_KEY =
  /^(amount|amount_delivered|total_amount_delivered|total_delivered_amount|delivered_amount|cod_amount|total_cod_amount|total_cod|collected_amount|total_collected_amount)$/i;
const PAYABLE_DELIVERY_CHARGE_KEY =
  /^(due_bills|payable_delivery_charge|total_delivery_charge|delivery_charge|delivery_fee|total_delivery_fee)$/i;
const COD_CHARGE_KEY =
  /^(charges|cod_charge|total_cod_charge|cod_fee|total_cod_fee|cod_percentage_amount)$/i;
const NET_AMOUNT_KEY =
  /^(total|net_amount|net_payable|net_paid|net_payable_amount|payable_amount|total_paid|paid_amount)$/i;
const AVAILABLE_BALANCE_KEY = /^(available_balance|current_balance)$/i;
const PARCEL_COUNT_KEY =
  /^(total_parcels?|parcels?_count|parcels?|consignments?_count|total_consignments?|number_of_parcels?)$/i;

// Fill the missing side of net + charges = gross when two sides are present.
function deriveAmounts(p: ParsedSteadfastPayment): ParsedSteadfastPayment {
  const delivery = p.deliveryCharge ?? 0;
  const cod = p.codCharge ?? 0;
  if (p.netAmount == null && p.amountDelivered != null) {
    p.netAmount = round2(p.amountDelivered - delivery - cod);
  } else if (p.amountDelivered == null && p.netAmount != null) {
    p.amountDelivered = round2(p.netAmount + delivery + cod);
  }
  return p;
}

export function parsePaymentListItem(item: unknown): ParsedSteadfastPayment | null {
  // §2.1 — the real rows carry payment_id as the "SFC-…" invoice string; take
  // its numeric tail (which the detail endpoint accepts) as the id.
  const id = paymentIdNumber(pick(item, PAYMENT_ID_KEY, 1));
  if (id == null || id <= 0) return null;

  let invoiceNo = pickString(item, INVOICE_NO_KEY, 1);
  // Fallback: any own string value shaped like their SFC- invoice code (the
  // real payment_id itself is exactly that, so the invoice is never lost).
  if (!invoiceNo && item != null && typeof item === "object" && !Array.isArray(item)) {
    for (const value of Object.values(item as Record<string, unknown>)) {
      if (typeof value === "string" && /^SFC-\d+$/i.test(value.trim())) {
        invoiceNo = value.trim();
        break;
      }
    }
  }

  const statusRaw = pickString(item, STATUS_KEY, 1);
  return deriveAmounts({
    steadfastPaymentId: id,
    invoiceNo,
    statusRaw,
    status: normalizeSteadfastPaymentStatus(statusRaw),
    paymentDate: pickDate(item, PAYMENT_DATE_KEYS),
    amountDelivered: pickNumber(item, AMOUNT_DELIVERED_KEY, 1),
    deliveryCharge: pickNumber(item, PAYABLE_DELIVERY_CHARGE_KEY, 1),
    codCharge: pickNumber(item, COD_CHARGE_KEY, 1),
    netAmount: pickNumber(item, NET_AMOUNT_KEY, 1),
    availableBalance: pickNumber(item, AVAILABLE_BALANCE_KEY, 1),
    parcelCount: pickNumber(item, PARCEL_COUNT_KEY, 1),
    raw: item,
  });
}

export function parsePaymentsList(raw: unknown): ParsedSteadfastPayment[] {
  const parsed: ParsedSteadfastPayment[] = [];
  for (const item of findPaymentArray(raw)) {
    const p = parsePaymentListItem(item);
    if (p) parsed.push(p);
  }
  return parsed;
}

// ---------- detail: the cleared-consignment list ----------

const CONSIGNMENT_ID_KEY = /^(consignment_id|consignmentid|cid)$/i;
const CONSIGNMENT_COD_KEY =
  /^(cod_amount|cod|collected_amount|amount)$/i;
// Their per-parcel delivery charge is the invoice's "bill" column; match every
// plausible spelling. Anchored so cod_charge/return_charge never leak in.
const CONSIGNMENT_BILL_KEY =
  /^(bill|bills|total_bill|delivery_bill|payable_delivery_charge|delivery_charge|delivery_fee|charge)$/i;

function looksLikeConsignment(node: unknown): boolean {
  if (node == null || typeof node !== "object" || Array.isArray(node)) return false;
  const keys = Object.keys(node as Record<string, unknown>);
  const hasCid = keys.some((k) => CONSIGNMENT_ID_KEY.test(k));
  const hasInvoiceAndMoney =
    keys.some((k) => INVOICE_NO_KEY.test(k) || /^tracking_code$/i.test(k)) &&
    keys.some((k) => CONSIGNMENT_COD_KEY.test(k) || CONSIGNMENT_BILL_KEY.test(k));
  return hasCid || hasInvoiceAndMoney;
}

export function findConsignmentArray(raw: unknown): unknown[] {
  const seen = new Set<object>();
  function scan(node: unknown, depth: number): unknown[] | null {
    if (node == null || depth > 4) return null;
    if (Array.isArray(node)) {
      return node.length > 0 && node.every(looksLikeConsignment) ? node : null;
    }
    if (typeof node !== "object") return null;
    if (seen.has(node as object)) return null;
    seen.add(node as object);
    for (const value of Object.values(node as Record<string, unknown>)) {
      const found = scan(value, depth + 1);
      if (found) return found;
    }
    return null;
  }
  return scan(raw, 0) ?? [];
}

export function parsePaymentConsignment(item: unknown): ParsedPaymentConsignment {
  return {
    consignmentId: pickNumber(item, CONSIGNMENT_ID_KEY, 1),
    invoice: pickString(item, INVOICE_NO_KEY, 1),
    codAmount: pickNumber(item, CONSIGNMENT_COD_KEY, 1),
    deliveryCharge: pickNumber(item, CONSIGNMENT_BILL_KEY, 1),
    statusRaw: pickString(item, STATUS_KEY, 0),
    raw: item,
  };
}

export interface ParsedPaymentDetail {
  // Payment-level fields the detail carries (often fuller than the list row) —
  // merged over the stored record where non-null.
  payment: ParsedSteadfastPayment | null;
  consignments: ParsedPaymentConsignment[];
}

export function parsePaymentDetail(raw: unknown): ParsedPaymentDetail {
  // The payment object may BE the response, or sit under payment/data/invoice.
  let paymentNode: unknown = raw;
  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    if (!looksLikePayment(raw)) {
      for (const value of Object.values(raw as Record<string, unknown>)) {
        if (looksLikePayment(value)) {
          paymentNode = value;
          break;
        }
      }
    }
  }
  return {
    payment: parsePaymentListItem(paymentNode),
    consignments: findConsignmentArray(raw).map(parsePaymentConsignment),
  };
}

// ---------- serialized shapes (server → client) ----------

// One payout row on the Courier page's payments list. Serialized by
// lib/steadfast-payments.ts (server); typed here so the client card imports no
// server code.
export interface SteadfastPaymentRow {
  id: number;
  steadfastPaymentId: number;
  invoiceNo: string | null;
  status: SteadfastPaymentStatusValue;
  paymentDate: string; // ISO
  amountDelivered: number;
  deliveryCharge: number;
  codCharge: number;
  netAmount: number;
  parcelCount: number;
  matchedCount: number;
  unmatchedCount: number;
  reconciles: boolean; // net + charges = gross (2p slack)
  discrepancyCount: number; // §2.7 — open MISMATCH/DISPUTED consignments
}

export interface SteadfastPaymentItemRow {
  id: number;
  consignmentId: number | null;
  invoice: string | null;
  codAmount: number; // THEIR per-parcel gross COD (verbatim)
  deliveryCharge: number | null; // their per-parcel "bill"
  orderId: number | null;
  orderNo: string | null;
  orderStatus: string | null;
  matched: boolean;
  settled: boolean; // created a COD payment row (or was already reconciled)
  // §2.7 justification columns
  ourGross: number | null; // the shipment's recorded COD
  expectedNet: number | null; // OUR computed net receivable (frozen at judge time)
  paidNet: number | null; // their per-parcel net when derivable
  reconcileStatus: SteadfastReconcileStatusValue;
  resolvedAt: string | null;
  resolveNote: string | null;
}

// The expandable detail view (GET /api/couriers/steadfast/payments/[id]) —
// §2.7: this IS the payout report (total paid vs Σ our expected nets, the
// per-consignment comparison table and the discrepancy count).
export type SteadfastPaymentDetailRow = SteadfastPaymentRow & {
  expectedNetSum: number | null; // Σ our expected nets (judged items)
  paidVsExpectedDiff: number | null; // their net − Σ expected (fully judged only)
  reconciledAt: string | null;
  items: SteadfastPaymentItemRow[];
};

// ---------- Round 2 §2.7 — per-order net receivable ----------

// The payout math, per the spec and verified against real invoices:
//   subtotal = COD − courier delivery charge
//   COD fee  = feePct% of the SUBTOTAL (not of the raw COD — their real
//              invoices bear this out: 2200 − 135 = 2065 → 1% ≈ 21 ✓)
//   net receivable = COD − delivery charge − COD fee
// Delivery charge: Steadfast's ACTUAL when known (webhook/invoice), else our
// zone+weight estimate — `chargeKnown` says which one the figure is built on.
export interface NetReceivable {
  deliveryCharge: number; // the charge used (0 when neither actual nor estimate)
  codFee: number;
  deduction: number; // delivery charge + COD fee
  netReceivable: number; // COD − deduction
  chargeKnown: boolean; // true = actual SF charge; false = estimate/none
}

export function computeNetReceivable(args: {
  codAmount: number;
  courierCostActual?: number | null;
  courierCostEstimated?: number | null;
  codFeePercent?: number | null; // Steadfast courier row's fee %, default 1
}): NetReceivable {
  const cod = round2(Math.max(args.codAmount, 0));
  const actual =
    args.courierCostActual != null && args.courierCostActual > 0
      ? args.courierCostActual
      : null;
  const estimate =
    args.courierCostEstimated != null && args.courierCostEstimated > 0
      ? args.courierCostEstimated
      : null;
  const charge = round2(actual ?? estimate ?? 0);
  const feePct = args.codFeePercent != null ? Number(args.codFeePercent) : 1;
  const codFee = round2(((cod - charge) * feePct) / 100);
  const deduction = round2(charge + codFee);
  return {
    deliveryCharge: charge,
    codFee,
    deduction,
    netReceivable: round2(cod - deduction),
    chargeKnown: actual != null,
  };
}

// Slack for the payout match verdict (their per-parcel fee rounding drifts by
// a taka or two — e.g. a real 6530-subtotal payout carried a 64tk fee where
// 1% is 65.30).
export const PAYOUT_MATCH_TOLERANCE = 2;

// §2.7 — the per-consignment reconcile verdict lifecycle. PENDING until the
// payout is PAID with a detail on hand; then MATCHED (auto-completed) or
// MISMATCH (discrepancy list) → resolved to ACCEPTED / DISPUTED by
// Admin/Accounts.
export type SteadfastReconcileStatusValue =
  | "PENDING"
  | "MATCHED"
  | "MISMATCH"
  | "ACCEPTED"
  | "DISPUTED";

export const STEADFAST_RECONCILE_STATUS_LABELS: Record<
  SteadfastReconcileStatusValue,
  string
> = {
  PENDING: "Pending",
  MATCHED: "Matched",
  MISMATCH: "Mismatch",
  ACCEPTED: "Accepted",
  DISPUTED: "Disputed",
};

// ---------- the reconcile identity ----------

// NET collection + the two charge lines must always tie back to GROSS
// (net + delivery charge + COD charge = amount delivered). 2p slack for their
// rounding. Used by the verify script and surfaced as a UI warning badge.
export function paymentReconciles(p: {
  amountDelivered: number;
  deliveryCharge: number;
  codCharge: number;
  netAmount: number;
}): boolean {
  return (
    Math.abs(p.amountDelivered - (p.netAmount + p.deliveryCharge + p.codCharge)) <=
    0.02
  );
}
