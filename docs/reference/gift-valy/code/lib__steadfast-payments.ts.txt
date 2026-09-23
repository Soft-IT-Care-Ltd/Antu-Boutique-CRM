import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { recomputeDue, dhakaDateBound, applyStatusTransition } from "./orders";
import type { OrderStatusValue } from "./order-constants";
import { AuthzError } from "./authz";
import { getSystemUserId } from "./system-user";
import { requireEnabledSteadfast } from "./steadfast-integration";
import { getPayments, getPaymentDetail } from "./steadfast";
import {
  getSteadfastPayoutWalletId,
  getSteadfastPaymentsLastPage,
  setSteadfastPaymentsLastPage,
} from "./settings";
import {
  COURIER_DELIVERY_CHARGE_EXPENSE_CATEGORY,
  COD_CHARGE_EXPENSE_CATEGORY,
} from "./courier-constants";
import { STEADFAST_COURIER_NAME } from "./steadfast-constants";
import {
  computeNetReceivable,
  parsePaymentsList,
  parsePaymentDetail,
  round2,
  PAYOUT_MATCH_TOLERANCE,
  type ParsedPaymentConsignment,
  type ParsedSteadfastPayment,
  type SteadfastPaymentDetailRow,
} from "./steadfast-payments-constants";

// ============ CORRECTIONS Orders §R8 — Steadfast payments sync ============
//
// The single place a Steadfast payout becomes Gift Valy money. The hourly cron,
// the Courier-page "Sync payments" button and the dashboard widget's refresh
// icon all run runSteadfastPaymentsSync, which fetches GET /payments (+ details)
// and routes every payment through ingestSteadfastPayment — one transaction per
// payment, network strictly outside transactions (§5 pattern).
//
// Accounting (the owner's NET-collection decision):
//   • per-ORDER payment rows stay GROSS — each cleared consignment creates a
//     COD_COURIER payment for its full per-parcel COD, settling the customer's
//     due correctly (the customer DID pay the full COD; Steadfast deducted its
//     charges before remitting). Never net against a due.
//   • the payable delivery charge and the ~1% COD fee post ONCE per paid
//     payment as real-number expenses ("Courier Delivery Charge" / "COD
//     Charge", ref = the steadfast_payments row).
//   • payment rows + both expenses carry the configured payout wallet, so the
//     wallet's running balance (in − out, lib/reports.ts §9.3) moves by exactly
//     the NET deposit — and net + charges = gross reconciles by construction.
//
// Idempotency (replay-safe): payments/items upsert by their Steadfast ids; a
// shipment already cod_received is skipped (its item keeps order_payment_id
// null); the two expenses are guarded by their *ExpenseId columns. Re-ingesting
// a paid payment is a no-op; a processing → paid transition fires the money
// side effects exactly once.

const DETAIL_FETCHES_PER_RUN = 10; // stay gentle on their API
// §2.1 — GET /payments pages are oldest-first with NO pagination metadata
// (verified in production: 60+ pages of 10, empty list past the end), so the
// sync hunts the TAIL (where new payouts land) instead of following
// advertised pages. Probes per run are capped so a wildly stale cursor can
// never turn one cron tick into an unbounded crawl.
const MAX_PAGE_PROBES_PER_RUN = 40;
// Only payouts dated after our first real Steadfast shipment (minus slack) are
// ingested — the merchant account predates this software by years, and pulling
// 2023-era payouts in would flood the books with money the system never saw.
const PAYMENTS_ANCHOR_SLACK_MS = 3 * 24 * 60 * 60 * 1000;
// A paid payout with unmatched/unreconciled items retries its detail fetch on
// later runs, but only while it is recent — permanently foreign consignments
// (panel-sent parcels) must not re-fetch hourly forever.
const DETAIL_RETRY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
// The §R8 "hourly poller" — the */15 status cron hosts the payments sync but
// only runs it when the last one is at least this old.
export const PAYMENTS_SYNC_MIN_GAP_MS = 60 * 60 * 1000;

export interface PaymentIngestOutcome {
  paymentRecordId: number;
  created: boolean; // first time we saw this payment
  becamePaid: boolean; // processing → paid on THIS ingest
  reconciledNow: boolean; // paid-side effects ran for the first time
  ordersSettled: number; // COD_COURIER payment rows created
  codRecorded: number; // ৳ recorded on orders (gross)
  matched: number; // consignments matched to our shipments
  unmatched: number; // consignments we don't recognize (flagged list)
  estimatesReplaced: number; // per-shipment estimated COD-fee expenses removed
  discrepancies: number; // §2.7 — consignments judged MISMATCH this ingest
  completed: number; // §2.7 — orders auto-moved DELIVERED → COMPLETED
}

export interface PaymentsSyncSummary {
  payments: number; // payment records seen in the list
  created: number;
  paidTransitions: number;
  ordersSettled: number;
  codRecorded: number;
  unmatched: number;
  discrepancies: number; // §2.7 — mismatches flagged this run
  completed: number; // §2.7 — orders auto-completed this run
  detailsFetched: number;
  pageProbes: number; // §2.1 — GET /payments calls this run (tail hunt)
  note?: string; // e.g. "no Steadfast shipments yet — nothing to reconcile"
  errors: { steadfastPaymentId: number | null; error: string }[];
}

// One cleared consignment resolved against our data.
interface MatchedConsignment {
  parsed: ParsedPaymentConsignment;
  shipment: {
    id: number;
    codReceived: boolean;
    codFeeExpenseId: number | null;
    codAmount: Prisma.Decimal;
    status: string;
    order: { id: number; orderNo: string; dueAmount: Prisma.Decimal };
  } | null;
}

async function expenseCategoryId(
  tx: Prisma.TransactionClient,
  name: string
): Promise<number> {
  const category = await tx.expenseCategory.upsert({
    where: { name },
    update: {},
    create: { name, costType: "VARIABLE" },
  });
  return category.id;
}

// Match the invoice's consignments to our shipments: consignment_id first
// (unique on shipments), their invoice (= our order_no) as fallback.
async function matchConsignments(
  tx: Prisma.TransactionClient,
  consignments: ParsedPaymentConsignment[]
): Promise<MatchedConsignment[]> {
  const cids = consignments
    .map((c) => c.consignmentId)
    .filter((v): v is number => v != null);
  const invoices = consignments
    .map((c) => c.invoice)
    .filter((v): v is string => v != null);

  const select = {
    id: true,
    codReceived: true,
    codFeeExpenseId: true,
    codAmount: true,
    status: true,
    consignmentId: true,
    order: { select: { id: true, orderNo: true, dueAmount: true } },
  } satisfies Prisma.ShipmentSelect;

  const [byCid, byInvoice] = await Promise.all([
    cids.length
      ? tx.shipment.findMany({
          where: { consignmentId: { in: cids.map(BigInt) } },
          select,
        })
      : [],
    invoices.length
      ? tx.shipment.findMany({
          where: { order: { orderNo: { in: invoices } } },
          select,
        })
      : [],
  ]);
  const cidMap = new Map(byCid.map((s) => [Number(s.consignmentId), s]));
  const invoiceMap = new Map(byInvoice.map((s) => [s.order.orderNo, s]));

  return consignments.map((parsed) => ({
    parsed,
    shipment:
      (parsed.consignmentId != null ? cidMap.get(parsed.consignmentId) : undefined) ??
      (parsed.invoice != null ? invoiceMap.get(parsed.invoice) : undefined) ??
      null,
  }));
}

export async function ingestSteadfastPayment(
  tx: Prisma.TransactionClient,
  args: {
    parsed: ParsedSteadfastPayment;
    // null/undefined = no detail fetched this run (list-only refresh).
    consignments?: ParsedPaymentConsignment[] | null;
    detailRaw?: unknown;
    walletId: number | null;
    userId: number;
    // §2.7 — the Steadfast courier row's COD fee % (default 1).
    codFeePercent?: number | null;
    now?: Date;
  }
): Promise<PaymentIngestOutcome> {
  const { parsed } = args;
  const now = args.now ?? new Date();

  const existing = await tx.steadfastPayment.findUnique({
    where: { steadfastPaymentId: BigInt(parsed.steadfastPaymentId) },
    include: { items: { select: { id: true, consignmentId: true, invoice: true } } },
  });

  // Once PAID, never downgraded — a stale list page can't un-pay a payout.
  const status =
    existing?.status === "PAID" ? "PAID" : parsed.status;
  const becamePaid =
    status === "PAID" && (existing ? existing.status !== "PAID" : true);

  const amounts = {
    invoiceNo: parsed.invoiceNo ?? existing?.invoiceNo ?? null,
    amountDelivered:
      parsed.amountDelivered ?? Number(existing?.amountDelivered ?? 0),
    deliveryCharge: parsed.deliveryCharge ?? Number(existing?.deliveryCharge ?? 0),
    codCharge: parsed.codCharge ?? Number(existing?.codCharge ?? 0),
    netAmount: parsed.netAmount ?? Number(existing?.netAmount ?? 0),
    availableBalance:
      parsed.availableBalance ??
      (existing?.availableBalance != null ? Number(existing.availableBalance) : null),
  };

  // §2.5 — prefer the invoice's own paid_at (Dhaka-parsed) over our clock.
  const paidAtValue = parsed.paymentDate ?? now;
  const record = existing
    ? await tx.steadfastPayment.update({
        where: { id: existing.id },
        data: {
          ...amounts,
          status,
          paymentDate: parsed.paymentDate ?? existing.paymentDate,
          paidAt: existing.paidAt ?? (status === "PAID" ? paidAtValue : null),
          // First-seen payloads are kept verbatim (shape discovery); only fill
          // the detail once.
          ...(existing.rawDetailPayload == null && args.detailRaw !== undefined
            ? { rawDetailPayload: args.detailRaw as Prisma.InputJsonValue }
            : {}),
        },
      })
    : await tx.steadfastPayment.create({
        data: {
          steadfastPaymentId: BigInt(parsed.steadfastPaymentId),
          ...amounts,
          status,
          paymentDate: parsed.paymentDate ?? now,
          paidAt: status === "PAID" ? paidAtValue : null,
          rawPayload: (parsed.raw ?? {}) as Prisma.InputJsonValue,
          ...(args.detailRaw !== undefined
            ? { rawDetailPayload: args.detailRaw as Prisma.InputJsonValue }
            : {}),
        },
      });

  const outcome: PaymentIngestOutcome = {
    paymentRecordId: record.id,
    created: !existing,
    becamePaid,
    reconciledNow: false,
    ordersSettled: 0,
    codRecorded: 0,
    matched: 0,
    unmatched: 0,
    estimatesReplaced: 0,
    discrepancies: 0,
    completed: 0,
  };

  // ---- consignment items (only when a detail payload is on hand) ----
  if (args.consignments && args.consignments.length > 0) {
    const matched = await matchConsignments(tx, args.consignments);
    for (const { parsed: c, shipment } of matched) {
      const data = {
        invoice: c.invoice,
        codAmount: round2(c.codAmount ?? Number(shipment?.codAmount ?? 0)),
        deliveryCharge: c.deliveryCharge != null ? round2(c.deliveryCharge) : null,
        status: c.statusRaw,
        shipmentId: shipment?.id ?? null,
        orderId: shipment?.order.id ?? null,
        rawPayload: (c.raw ?? {}) as Prisma.InputJsonValue,
      };
      if (c.consignmentId != null) {
        await tx.steadfastPaymentItem.upsert({
          where: {
            paymentId_consignmentId: {
              paymentId: record.id,
              consignmentId: BigInt(c.consignmentId),
            },
          },
          update: data,
          create: {
            paymentId: record.id,
            consignmentId: BigInt(c.consignmentId),
            ...data,
          },
        });
      } else {
        // No consignment id in the payload — dedupe by invoice so replays
        // don't multiply rows.
        const prior = c.invoice
          ? await tx.steadfastPaymentItem.findFirst({
              where: { paymentId: record.id, consignmentId: null, invoice: c.invoice },
              select: { id: true },
            })
          : null;
        if (prior) {
          await tx.steadfastPaymentItem.update({ where: { id: prior.id }, data });
        } else {
          await tx.steadfastPaymentItem.create({
            data: { paymentId: record.id, consignmentId: null, ...data },
          });
        }
      }
    }
    await tx.steadfastPayment.update({
      where: { id: record.id },
      data: {
        parcelCount: Math.max(parsed.parcelCount ?? 0, matched.length),
      },
    });
  }

  // ---- paid-side effects — the §2.7 justification engine (idempotent,
  // re-run on every PAID ingest so late-matched consignments still judge) ----
  if (status === "PAID") {
    const feePct =
      args.codFeePercent != null ? Number(args.codFeePercent) : 1;
    const items = await tx.steadfastPaymentItem.findMany({
      where: { paymentId: record.id },
      include: {
        shipment: {
          select: {
            id: true,
            codReceived: true,
            codFeeExpenseId: true,
            status: true,
            codAmount: true,
            courierCostActual: true,
            courierCostEstimated: true,
            order: {
              select: { id: true, orderNo: true, dueAmount: true, status: true },
            },
          },
        },
      },
    });
    outcome.matched = items.filter((i) => i.shipmentId != null).length;
    outcome.unmatched = items.length - outcome.matched;

    const receivedDate = record.paymentDate ?? now;
    const label = amounts.invoiceNo ?? `#${parsed.steadfastPaymentId}`;
    for (const item of items) {
      const shipment = item.shipment;
      if (!shipment) continue;

      // The invoice's per-parcel bill is the authoritative delivery charge —
      // it replaces webhook/tracking-page estimates in courier_cost_actual.
      const billNum =
        item.deliveryCharge != null && Number(item.deliveryCharge) > 0
          ? round2(Number(item.deliveryCharge))
          : null;
      if (billNum != null) {
        await tx.shipment.update({
          where: { id: shipment.id },
          data: { courierCostActual: billNum, updatedBy: args.userId },
        });
      }

      // §2.7 verdict — their figures vs OUR computed net receivable.
      // theirGross is the payload's per-parcel COD verbatim; theirNet is only
      // derivable when their per-parcel bill is on hand or the payout has a
      // single consignment (then the payout's own net IS this parcel's net) —
      // the real payloads carry no per-parcel bill, so multi-parcel payouts
      // are judged at gross level here and at payout level in the report.
      const theirGross = round2(Number(item.codAmount));
      const expected = computeNetReceivable({
        codAmount: Number(shipment.codAmount),
        courierCostActual:
          billNum ??
          (shipment.courierCostActual != null
            ? Number(shipment.courierCostActual)
            : null),
        courierCostEstimated:
          shipment.courierCostEstimated != null
            ? Number(shipment.courierCostEstimated)
            : null,
        codFeePercent: feePct,
      });
      let theirNet: number | null = null;
      if (billNum != null) {
        const feeOnTheirs = round2(((theirGross - billNum) * feePct) / 100);
        theirNet = round2(theirGross - billNum - feeOnTheirs);
      } else if (items.length === 1 && amounts.amountDelivered > 0) {
        theirNet = round2(amounts.netAmount);
      }

      const alreadySettled = shipment.codReceived || item.orderPaymentId != null;
      const priorStatus = item.reconcileStatus;
      let verdict = priorStatus;
      if (priorStatus === "PENDING" || priorStatus === "MISMATCH") {
        if (alreadySettled) {
          // Manually/pre-§2.7 reconciled — the money question is closed.
          verdict = "MATCHED";
        } else {
          const grossOk =
            Math.abs(theirGross - round2(Number(shipment.codAmount))) <=
            PAYOUT_MATCH_TOLERANCE;
          const netOk =
            theirNet == null ||
            Math.abs(theirNet - expected.netReceivable) <=
              PAYOUT_MATCH_TOLERANCE;
          verdict = grossOk && netOk ? "MATCHED" : "MISMATCH";
        }
      }

      if (verdict === "MATCHED" && !alreadySettled) {
        // GROSS due settlement at THEIR verified figure (equals ours within
        // tolerance), capped at the outstanding due so a stray payload figure
        // can never drive a due negative.
        const due = Number(shipment.order.dueAmount);
        const payAmount = round2(Math.min(theirGross, Math.max(due, 0)));
        let orderPaymentId: number | null = null;
        if (payAmount > 0) {
          const payment = await tx.payment.create({
            data: {
              orderId: shipment.order.id,
              paymentDate: receivedDate,
              type: "COD_COURIER",
              method: "COURIER_COD",
              amount: payAmount,
              walletId: args.walletId,
              isVerified: true, // the payout invoice IS the statement line
              verifiedBy: args.userId,
              createdBy: args.userId,
              updatedBy: args.userId,
            },
          });
          orderPaymentId = payment.id;
          await recomputeDue(tx, shipment.order.id);
        }
        await tx.shipment.update({
          where: { id: shipment.id },
          data: {
            codReceived: true,
            codReceivedAt: receivedDate,
            // A payout for a parcel our books don't show as delivered means our
            // status lagged (missed webhook / manual gap) — flag it, never move
            // the order behind the operator's back.
            ...(shipment.status !== "DELIVERED" ? { needsAttention: true } : {}),
            updatedBy: args.userId,
          },
        });
        await tx.steadfastPaymentItem.update({
          where: { id: item.id },
          data: {
            orderPaymentId,
            reconcileStatus: "MATCHED",
            expectedNet: expected.netReceivable,
            paidNet: theirNet,
          },
        });
        outcome.ordersSettled += 1;
        outcome.codRecorded = round2(outcome.codRecorded + payAmount);
        // §2.7 auto-COMPLETE: the payout justified this order's money —
        // DELIVERED with a zero due moves on to COMPLETED.
        if (
          await autoCompleteOrder(
            tx,
            shipment.order.id,
            args.userId,
            `Steadfast payout ${label} reconciled — auto-completed`
          )
        ) {
          outcome.completed += 1;
        }
      } else if (verdict === "MATCHED" && alreadySettled) {
        // Manually pre-reconciled parcel now covered by a real payout — the
        // skip keeps it idempotent, but two corrections make the books true:
        // 1. adopt the existing manual COD row as this item's payment link, so
        //    the dashboard's payout-vs-manual split counts the parcel ONCE
        //    (as net, via the payout) instead of net + manual gross;
        // 2. the payment-level COD Charge carries its REAL fee, so the manual
        //    flow's ESTIMATED per-shipment fee expense would double-count —
        //    replace the estimate with the invoice's number by removing it.
        if (item.orderPaymentId == null) {
          const manualRow = await tx.payment.findFirst({
            where: {
              orderId: shipment.order.id,
              type: "COD_COURIER",
              isRejected: false,
            },
            orderBy: { id: "desc" },
            select: { id: true },
          });
          if (manualRow) {
            await tx.steadfastPaymentItem.update({
              where: { id: item.id },
              data: { orderPaymentId: manualRow.id },
            });
          }
          if (shipment.codFeeExpenseId != null) {
            await tx.expense.delete({ where: { id: shipment.codFeeExpenseId } });
            await tx.shipment.update({
              where: { id: shipment.id },
              data: { codFeeExpenseId: null, updatedBy: args.userId },
            });
            outcome.estimatesReplaced += 1;
          }
        }
        if (priorStatus !== "MATCHED") {
          await tx.steadfastPaymentItem.update({
            where: { id: item.id },
            data: {
              reconcileStatus: "MATCHED",
              expectedNet: expected.netReceivable,
              paidNet: theirNet,
            },
          });
        }
        if (
          await autoCompleteOrder(
            tx,
            shipment.order.id,
            args.userId,
            `Steadfast payout ${label} reconciled — auto-completed`
          )
        ) {
          outcome.completed += 1;
        }
      } else if (verdict === "MISMATCH") {
        // §2.7 discrepancy: NO money moves, the order does NOT complete — it
        // joins the discrepancy list (⚠ on the shipment) until Admin/Accounts
        // accepts their figure (with a reason) or marks it disputed.
        await tx.steadfastPaymentItem.update({
          where: { id: item.id },
          data: {
            reconcileStatus: "MISMATCH",
            expectedNet: expected.netReceivable,
            paidNet: theirNet,
          },
        });
        await tx.shipment.update({
          where: { id: shipment.id },
          data: { needsAttention: true, updatedBy: args.userId },
        });
        outcome.discrepancies += 1;
      } else if (verdict === "ACCEPTED") {
        // Resolved earlier — just retry the auto-complete (the due may have
        // cleared since, e.g. a later partial payment).
        if (
          await autoCompleteOrder(
            tx,
            shipment.order.id,
            args.userId,
            `Steadfast payout ${label} discrepancy accepted — auto-completed`
          )
        ) {
          outcome.completed += 1;
        }
      }
      // DISPUTED items stay put until a human changes their mind.
    }

    outcome.reconciledNow = await finalizeSteadfastPayment(tx, record.id, {
      walletId: args.walletId,
      userId: args.userId,
      now,
    });
  }

  return outcome;
}

// §2.7 auto-COMPLETE — a payout-justified order moves DELIVERED → COMPLETED
// once its due is zero, through the SAME shared transition as a manual move
// (order_status_history + stock hook). Any other state is left for a human.
async function autoCompleteOrder(
  tx: Prisma.TransactionClient,
  orderId: number,
  userId: number,
  note: string
): Promise<boolean> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, cancelReason: true, dueAmount: true },
  });
  if (!order || order.status !== "DELIVERED" || Number(order.dueAmount) !== 0) {
    return false;
  }
  await applyStatusTransition(
    tx,
    {
      id: order.id,
      status: order.status as OrderStatusValue,
      cancelReason: order.cancelReason,
    },
    "COMPLETED",
    userId,
    note
  );
  return true;
}

// Payment-level real-number expenses + reconciled_at — once per payout,
// guarded by the id columns, and ONLY when every consignment is ours AND in a
// justified state (MATCHED/ACCEPTED). A payout with foreign parcels or open
// discrepancies keeps its charges (and reconciled_at) on hold — §2.1/§2.7:
// booking their charge totals would pit expenses against income the system
// never sees. Called from the PAID ingest and again after each resolve.
// Returns true when the payout became reconciled on THIS call.
export async function finalizeSteadfastPayment(
  tx: Prisma.TransactionClient,
  paymentRecordId: number,
  args: { walletId: number | null; userId: number; now?: Date }
): Promise<boolean> {
  const now = args.now ?? new Date();
  const record = await tx.steadfastPayment.findUnique({
    where: { id: paymentRecordId },
    include: {
      items: { select: { shipmentId: true, reconcileStatus: true } },
    },
  });
  if (!record || record.status !== "PAID") return false;

  const allJustified =
    record.items.length > 0 &&
    record.items.every(
      (i) =>
        i.shipmentId != null &&
        (i.reconcileStatus === "MATCHED" || i.reconcileStatus === "ACCEPTED")
    );
  if (!allJustified) {
    await tx.steadfastPayment.update({
      where: { id: record.id },
      data: { walletId: record.walletId ?? args.walletId },
    });
    return false;
  }

  const label = record.invoiceNo ?? `#${record.steadfastPaymentId}`;
  const expenseDate = dhakaDateBound(record.paymentDate ?? now);
  let deliveryChargeExpenseId = record.deliveryChargeExpenseId;
  if (deliveryChargeExpenseId == null && Number(record.deliveryCharge) > 0) {
    const expense = await tx.expense.create({
      data: {
        expenseDate,
        categoryId: await expenseCategoryId(
          tx,
          COURIER_DELIVERY_CHARGE_EXPENSE_CATEGORY
        ),
        amount: round2(Number(record.deliveryCharge)),
        walletId: args.walletId,
        notes: `Steadfast payout ${label} — delivery charge`,
        refTable: "steadfast_payments",
        refId: record.id,
        createdBy: args.userId,
        updatedBy: args.userId,
      },
    });
    deliveryChargeExpenseId = expense.id;
  }
  let codChargeExpenseId = record.codChargeExpenseId;
  if (codChargeExpenseId == null && Number(record.codCharge) > 0) {
    const expense = await tx.expense.create({
      data: {
        expenseDate,
        categoryId: await expenseCategoryId(tx, COD_CHARGE_EXPENSE_CATEGORY),
        amount: round2(Number(record.codCharge)),
        walletId: args.walletId,
        notes: `Steadfast payout ${label} — COD charge`,
        refTable: "steadfast_payments",
        refId: record.id,
        createdBy: args.userId,
        updatedBy: args.userId,
      },
    });
    codChargeExpenseId = expense.id;
  }

  const reconciledNow = record.reconciledAt == null;
  await tx.steadfastPayment.update({
    where: { id: record.id },
    data: {
      deliveryChargeExpenseId,
      codChargeExpenseId,
      reconciledAt: record.reconciledAt ?? now,
      walletId: record.walletId ?? args.walletId,
    },
  });
  return reconciledNow;
}

// ---------- §2.7 — resolving a discrepancy (Admin/Accounts) ----------

export interface ResolveOutcome {
  reconcileStatus: "ACCEPTED" | "DISPUTED";
  settled: boolean; // a COD payment row was created now
  completed: boolean; // the order auto-completed now
  paymentReconciled: boolean; // the payout finalized (expenses posted) now
}

// Accept: Steadfast's figure becomes the recorded truth — their gross posts as
// the COD payment (capped at due), the shipment closes its COD wait, and the
// order auto-completes when the due reaches zero. A remaining due (their gross
// below our COD) stays visible on the order for the usual follow-up flows.
// Dispute: the item is marked DISPUTED with the note; nothing moves — the
// payout can never finalize around a disputed parcel.
export async function resolveSteadfastPaymentItem(
  tx: Prisma.TransactionClient,
  args: {
    itemId: number;
    action: "ACCEPT" | "DISPUTE";
    note: string | null;
    userId: number;
    walletId: number | null;
    now?: Date;
  }
): Promise<ResolveOutcome> {
  const now = args.now ?? new Date();
  const item = await tx.steadfastPaymentItem.findUnique({
    where: { id: args.itemId },
    include: {
      payment: { select: { id: true, status: true, paymentDate: true, invoiceNo: true, steadfastPaymentId: true } },
      shipment: {
        select: {
          id: true,
          codReceived: true,
          status: true,
          order: { select: { id: true, dueAmount: true } },
        },
      },
    },
  });
  if (!item) throw new AuthzError(404, "Payment item not found");
  if (!item.shipment) {
    throw new AuthzError(400, "This consignment is not matched to an order");
  }
  if (item.payment.status !== "PAID") {
    throw new AuthzError(400, "The payout is not paid yet");
  }
  if (item.reconcileStatus !== "MISMATCH" && item.reconcileStatus !== "DISPUTED") {
    throw new AuthzError(400, "No open discrepancy on this consignment");
  }

  const note = args.note?.trim() || null;
  if (args.action === "DISPUTE") {
    await tx.steadfastPaymentItem.update({
      where: { id: item.id },
      data: {
        reconcileStatus: "DISPUTED",
        resolvedBy: args.userId,
        resolvedAt: now,
        resolveNote: note,
      },
    });
    return {
      reconcileStatus: "DISPUTED",
      settled: false,
      completed: false,
      paymentReconciled: false,
    };
  }

  // ACCEPT — the reason is the justification trail; never optional.
  if (!note) {
    throw new AuthzError(400, "A reason is required to accept their figure");
  }
  const label =
    item.payment.invoiceNo ?? `#${item.payment.steadfastPaymentId}`;
  const receivedDate = item.payment.paymentDate ?? now;
  const theirGross = round2(Number(item.codAmount));
  let settled = false;
  let orderPaymentId: number | null = item.orderPaymentId;
  if (!item.shipment.codReceived) {
    const due = Number(item.shipment.order.dueAmount);
    const payAmount = round2(Math.min(theirGross, Math.max(due, 0)));
    if (payAmount > 0) {
      const payment = await tx.payment.create({
        data: {
          orderId: item.shipment.order.id,
          paymentDate: receivedDate,
          type: "COD_COURIER",
          method: "COURIER_COD",
          amount: payAmount,
          walletId: args.walletId,
          isVerified: true,
          verifiedBy: args.userId,
          createdBy: args.userId,
          updatedBy: args.userId,
        },
      });
      orderPaymentId = payment.id;
      await recomputeDue(tx, item.shipment.order.id);
      settled = true;
    }
    await tx.shipment.update({
      where: { id: item.shipment.id },
      data: {
        codReceived: true,
        codReceivedAt: receivedDate,
        needsAttention: false, // the ⚠ was this discrepancy — it is resolved
        updatedBy: args.userId,
      },
    });
  }
  await tx.steadfastPaymentItem.update({
    where: { id: item.id },
    data: {
      orderPaymentId,
      reconcileStatus: "ACCEPTED",
      resolvedBy: args.userId,
      resolvedAt: now,
      resolveNote: note,
    },
  });
  const completed = await autoCompleteOrder(
    tx,
    item.shipment.order.id,
    args.userId,
    `Steadfast payout ${label} discrepancy accepted — auto-completed`
  );
  const paymentReconciled = await finalizeSteadfastPayment(tx, item.payment.id, {
    walletId: args.walletId,
    userId: args.userId,
    now,
  });
  return { reconcileStatus: "ACCEPTED", settled, completed, paymentReconciled };
}

// ---------- the poll: GET /payments (+ details) → ingest ----------

export async function runSteadfastPaymentsSync(opts?: {
  userId?: number;
}): Promise<PaymentsSyncSummary> {
  const { integration, creds } = await requireEnabledSteadfast();
  const walletId = await getSteadfastPayoutWalletId();
  const userId = opts?.userId ?? (await getSystemUserId(prisma));
  // §2.7 — the COD fee % lives on the Steadfast courier row (default 1%).
  const courier = await prisma.courier.findUnique({
    where: { name: STEADFAST_COURIER_NAME },
    select: { codFeePercent: true },
  });
  const codFeePercent =
    courier != null && Number(courier.codFeePercent) > 0
      ? Number(courier.codFeePercent)
      : 1;

  const summary: PaymentsSyncSummary = {
    payments: 0,
    created: 0,
    paidTransitions: 0,
    ordersSettled: 0,
    codRecorded: 0,
    unmatched: 0,
    discrepancies: 0,
    completed: 0,
    detailsFetched: 0,
    pageProbes: 0,
    errors: [],
  };

  // §2.1 anchor — payouts can only concern us from our first API-sent shipment
  // on; everything earlier belongs to the merchant's pre-software history.
  const firstShipment = await prisma.shipment.aggregate({
    _min: { createdAt: true },
    where: { consignmentId: { not: null } },
  });
  if (!firstShipment._min.createdAt) {
    summary.note = "no Steadfast shipments yet — nothing to reconcile";
    return summary;
  }
  const anchor = new Date(
    firstShipment._min.createdAt.getTime() - PAYMENTS_ANCHOR_SLACK_MS
  );

  // §2.1 tail hunt — the list is oldest-first with no pagination metadata, so
  // resume from the remembered tail page, gallop forward until the first empty
  // page, then bisect the exact tail. Steady state costs 2 probes; a first run
  // (or a long gap) costs ~a dozen instead of a 60-page crawl.
  const pageCache = new Map<number, ParsedSteadfastPayment[]>();
  const getPage = async (page: number): Promise<ParsedSteadfastPayment[]> => {
    const cached = pageCache.get(page);
    if (cached) return cached;
    summary.pageProbes += 1;
    const raw = await getPayments(creds, page);
    const batch = parsePaymentsList(raw);
    pageCache.set(page, batch);
    await new Promise((r) => setTimeout(r, 150)); // §5 gentle pacing
    return batch;
  };

  const parsed: ParsedSteadfastPayment[] = [];
  try {
    // Land the cursor on a non-empty page (halving down if the stored cursor
    // overshoots — e.g. after a restore from backup).
    let lo = await getSteadfastPaymentsLastPage();
    while (lo > 1 && (await getPage(lo)).length === 0) {
      lo = Math.max(1, Math.floor(lo / 2));
    }
    if ((await getPage(lo)).length > 0) {
      // Gallop forward to bracket the tail, then bisect.
      let step = 1;
      let hi: number | null = null;
      while (summary.pageProbes < MAX_PAGE_PROBES_PER_RUN) {
        const probe = lo + step;
        if ((await getPage(probe)).length > 0) {
          lo = probe;
          step *= 2;
        } else {
          hi = probe;
          break;
        }
      }
      if (hi != null) {
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          if ((await getPage(mid)).length > 0) lo = mid;
          else hi = mid;
        }
      }
      const tail = lo;

      // Collect payouts from the tail backwards until a page that is entirely
      // pre-anchor — earlier pages can only be older still.
      for (let p = tail; p >= 1; p--) {
        const batch = await getPage(p);
        if (batch.length === 0) break;
        parsed.unshift(
          ...batch.filter(
            (x) => x.paymentDate == null || x.paymentDate >= anchor
          )
        );
        const oldest = batch[0]?.paymentDate;
        if (oldest != null && oldest < anchor) break;
      }

      await setSteadfastPaymentsLastPage(tail);
    }
  } catch (e) {
    summary.errors.push({
      steadfastPaymentId: null,
      error: e instanceof Error ? e.message : "GET /payments failed",
    });
  }
  summary.payments = parsed.length;

  for (const p of parsed) {
    try {
      const existing = await prisma.steadfastPayment.findUnique({
        where: { steadfastPaymentId: BigInt(p.steadfastPaymentId) },
        select: {
          id: true,
          status: true,
          reconciledAt: true,
          rawDetailPayload: true,
          items: { where: { shipmentId: null }, select: { id: true }, take: 1 },
        },
      });

      // Fetch the invoice detail when we've never seen it, the status moved,
      // or a paid payout still has unreconciled/unmatched work — capped per
      // run, and (§2.1) retried only while the payout is recent: a payout of
      // panel-sent parcels will never match, and must not re-fetch forever.
      const statusMoved = existing != null && existing.status !== p.status;
      const recentEnough =
        p.paymentDate == null ||
        Date.now() - p.paymentDate.getTime() <= DETAIL_RETRY_WINDOW_MS;
      const wantsDetail =
        !existing ||
        existing.rawDetailPayload == null ||
        statusMoved ||
        (p.status === "PAID" &&
          recentEnough &&
          (existing.reconciledAt == null || existing.items.length > 0));
      let detailRaw: unknown;
      let consignments: ParsedPaymentConsignment[] | null = null;
      if (wantsDetail && summary.detailsFetched < DETAIL_FETCHES_PER_RUN) {
        summary.detailsFetched += 1;
        detailRaw = await getPaymentDetail(creds, p.steadfastPaymentId);
        const detail = parsePaymentDetail(detailRaw);
        consignments = detail.consignments;
        // The detail is usually fuller than the list row — prefer its figures.
        if (detail.payment && detail.payment.steadfastPaymentId === p.steadfastPaymentId) {
          for (const key of [
            "invoiceNo",
            "paymentDate",
            "amountDelivered",
            "deliveryCharge",
            "codCharge",
            "netAmount",
            "availableBalance",
            "parcelCount",
          ] as const) {
            if (detail.payment[key] != null) {
              (p as unknown as Record<string, unknown>)[key] = detail.payment[key];
            }
          }
        }
      }

      const outcome = await prisma.$transaction((tx) =>
        ingestSteadfastPayment(tx, {
          parsed: p,
          consignments,
          detailRaw,
          walletId,
          userId,
          codFeePercent,
        })
      );
      if (outcome.created) summary.created += 1;
      if (outcome.becamePaid) summary.paidTransitions += 1;
      summary.ordersSettled += outcome.ordersSettled;
      summary.codRecorded = round2(summary.codRecorded + outcome.codRecorded);
      summary.unmatched += outcome.unmatched;
      summary.discrepancies += outcome.discrepancies;
      summary.completed += outcome.completed;

      await new Promise((r) => setTimeout(r, 150)); // §5 gentle pacing
    } catch (e) {
      summary.errors.push({
        steadfastPaymentId: p.steadfastPaymentId,
        error: e instanceof Error ? e.message : "payment ingest failed",
      });
    }
  }

  await prisma.courierIntegration.update({
    where: { id: integration.id },
    data: { lastPaymentsSyncAt: new Date() },
  });

  return summary;
}

// ---------- serialization (Courier page + detail route) ----------

export type SteadfastPaymentWithItems = Prisma.SteadfastPaymentGetPayload<{
  include: {
    items: {
      include: {
        order: { select: { id: true; orderNo: true; status: true } };
        shipment: { select: { codAmount: true } };
      };
    };
  };
}>;

export function serializeSteadfastPayment(
  p: SteadfastPaymentWithItems
): SteadfastPaymentDetailRow {
  const gross = Number(p.amountDelivered);
  const delivery = Number(p.deliveryCharge);
  const cod = Number(p.codCharge);
  const net = Number(p.netAmount);
  const matchedCount = p.items.filter((i) => i.shipmentId != null).length;
  // §2.7 payout report roll-up: Σ our expected nets vs their total paid —
  // only meaningful once every consignment is ours and judged.
  const judged = p.items.filter((i) => i.expectedNet != null);
  const expectedNetSum =
    judged.length > 0
      ? round2(judged.reduce((s, i) => s + Number(i.expectedNet), 0))
      : null;
  const paidVsExpectedDiff =
    expectedNetSum != null &&
    judged.length === p.items.length &&
    matchedCount === p.items.length
      ? round2(net - expectedNetSum)
      : null;
  const discrepancyCount = p.items.filter(
    (i) => i.reconcileStatus === "MISMATCH" || i.reconcileStatus === "DISPUTED"
  ).length;
  return {
    id: p.id,
    steadfastPaymentId: Number(p.steadfastPaymentId),
    invoiceNo: p.invoiceNo,
    status: p.status,
    paymentDate: p.paymentDate.toISOString(),
    amountDelivered: gross,
    deliveryCharge: delivery,
    codCharge: cod,
    netAmount: net,
    parcelCount: p.parcelCount || p.items.length,
    matchedCount,
    unmatchedCount: p.items.length - matchedCount,
    reconciles: Math.abs(gross - (net + delivery + cod)) <= 0.02,
    expectedNetSum,
    paidVsExpectedDiff,
    discrepancyCount,
    reconciledAt: p.reconciledAt ? p.reconciledAt.toISOString() : null,
    items: p.items.map((i) => ({
      id: i.id,
      consignmentId: i.consignmentId != null ? Number(i.consignmentId) : null,
      invoice: i.invoice,
      codAmount: Number(i.codAmount),
      deliveryCharge: i.deliveryCharge != null ? Number(i.deliveryCharge) : null,
      orderId: i.order?.id ?? null,
      orderNo: i.order?.orderNo ?? null,
      orderStatus: i.order?.status ?? null,
      matched: i.shipmentId != null,
      settled: i.orderPaymentId != null,
      // §2.7 justification columns
      ourGross: i.shipment != null ? Number(i.shipment.codAmount) : null,
      expectedNet: i.expectedNet != null ? Number(i.expectedNet) : null,
      paidNet: i.paidNet != null ? Number(i.paidNet) : null,
      reconcileStatus: i.reconcileStatus,
      resolvedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
      resolveNote: i.resolveNote,
    })),
  };
}
