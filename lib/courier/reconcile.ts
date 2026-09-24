import type { CourierStatementSource, Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { completeStatementAmounts, computeNetReceivable, round2, withinTolerance } from "@/lib/courier/payouts/net";
import { toNumber } from "@/lib/money";
import { moveOrderStatus } from "@/lib/orders/lifecycle";
import { recomputeOrderDueAmount } from "@/lib/orders/totals";
import { postExchangeCourierCost } from "@/lib/returns/exchange-courier-cost";

// ============ COD reconciliation (PRD §4.9, Gift Valy Round 2 §2.1 / §2.7) ============
//
// The ONE place a courier statement becomes order money — a Steadfast payout
// synced from its API, or a statement Accounts imported (CSV) or typed in.
// Per line, once the statement is PAID:
//   match   consignment id → our shipment, else invoice → our order no.
//   judge   their gross COD vs ours, and — when their per-parcel net can be
//           derived — their net vs our net receivable (COD − delivery charge −
//           COD fee on the rest), both within ±৳2
//   MATCHED → a verified COURIER_COD payment settles the order's due (gross:
//           the customer paid the full COD; the courier's cut is an expense),
//           the shipment's COD is marked received, and a DELIVERED order with
//           nothing left to pay auto-moves to COMPLETED
//   MISMATCH → no money moves; the line waits in the discrepancy list for
//           ACCOUNTS to accept the courier's figure (reason required) or
//           dispute it
// When every line is MATCHED/ACCEPTED the statement is reconciled and its
// charges post as expenses exactly once.
//
// Idempotent: statements are unique per (courier, reference); a line's
// payment is a unique FK; a line already settled is never re-judged; the
// charges' expense FKs are unique. Re-syncing or re-importing changes nothing.

export class ReconcileError extends Error {}

export const COURIER_DELIVERY_CHARGE_EXPENSE_CATEGORY = "Courier delivery charge";
export const COD_CHARGE_EXPENSE_CATEGORY = "COD charge";

/**
 * Where a courier's net payout lands when nobody says otherwise: the first
 * active bank wallet (P2.3). Couriers pay out to the bank account.
 */
export async function defaultCourierPayoutWalletId(tx: Prisma.TransactionClient): Promise<string | null> {
  const wallet = await tx.wallet.findFirst({ where: { isActive: true, type: "BANK" }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true } });
  return wallet?.id ?? null;
}

export type StatementLineInput = {
  consignmentId?: string | null;
  invoice?: string | null;
  codAmount: number;
  deliveryCharge?: number | null;
  codCharge?: number | null;
  raw?: unknown;
};

export type StatementInput = {
  courierId: string;
  source: CourierStatementSource;
  reference: string;
  status: "PROCESSING" | "PAID";
  statementDate: Date;
  grossAmount?: number | null;
  deliveryCharge?: number | null;
  codCharge?: number | null;
  netAmount?: number | null;
  /** The wallet the net lands in; defaults to the first active bank wallet. */
  walletId?: string | null;
  note?: string | null;
  rawPayload?: unknown;
  rawDetailPayload?: unknown;
  /** null/undefined = no line detail on hand this time (Steadfast list-only refresh). */
  lines?: StatementLineInput[] | null;
};

export type IngestOutcome = {
  statementId: string;
  created: boolean;
  becamePaid: boolean;
  settled: number;
  codRecorded: number;
  discrepancies: number;
  unmatched: number;
  completed: number;
  reconciledNow: boolean;
};

const SETTLED = ["MATCHED", "ACCEPTED"] as const;

async function expenseCategoryId(tx: Prisma.TransactionClient, name: string, sortOrder: number): Promise<string> {
  const category = await tx.expenseCategory.upsert({ where: { name }, update: {}, create: { name, sortOrder, kind: "COURIER", isSystem: true } });
  return category.id;
}

export async function ingestCourierStatement(tx: Prisma.TransactionClient, input: StatementInput, actorId: string | null): Promise<IngestOutcome> {
  const existing = await tx.courierStatement.findUnique({
    where: { courierId_reference: { courierId: input.courierId, reference: input.reference } },
    include: { _count: { select: { lines: true } } },
  });

  // Once PAID, never downgraded — a stale list page can't un-pay a payout.
  const status = existing?.status === "PAID" ? "PAID" : input.status;
  const becamePaid = status === "PAID" && existing?.status !== "PAID";
  const lines = input.lines ?? [];
  const amounts = completeStatementAmounts(
    {
      grossAmount: input.grossAmount ?? (existing ? toNumber(existing.grossAmount) : null),
      deliveryCharge: input.deliveryCharge ?? (existing ? toNumber(existing.deliveryCharge) : null),
      codCharge: input.codCharge ?? (existing ? toNumber(existing.codCharge) : null),
      netAmount: input.netAmount ?? (existing ? toNumber(existing.netAmount) : null),
    },
    lines,
  );

  const statement = existing
    ? await tx.courierStatement.update({
        where: { id: existing.id },
        data: {
          ...amounts,
          status,
          ...(existing.rawDetailPayload == null && input.rawDetailPayload !== undefined ? { rawDetailPayload: input.rawDetailPayload as Prisma.InputJsonValue } : {}),
        },
      })
    : await tx.courierStatement.create({
        data: {
          courierId: input.courierId,
          source: input.source,
          reference: input.reference,
          status,
          statementDate: input.statementDate,
          ...amounts,
          walletId: input.walletId || (await defaultCourierPayoutWalletId(tx)),
          note: input.note?.trim() || null,
          rawPayload: (input.rawPayload ?? undefined) as Prisma.InputJsonValue | undefined,
          rawDetailPayload: (input.rawDetailPayload ?? undefined) as Prisma.InputJsonValue | undefined,
          createdById: actorId,
        },
      });

  // Lines are written once — a payout's consignment list never changes.
  if (lines.length > 0 && (existing?._count.lines ?? 0) === 0) {
    await tx.courierStatementLine.createMany({
      data: lines.map((l, i) => ({
        statementId: statement.id,
        lineNo: i + 1,
        consignmentId: l.consignmentId?.trim() || null,
        invoice: l.invoice?.trim() || null,
        codAmount: round2(l.codAmount),
        deliveryCharge: l.deliveryCharge == null ? null : round2(l.deliveryCharge),
        codCharge: l.codCharge == null ? null : round2(l.codCharge),
        rawPayload: (l.raw ?? undefined) as Prisma.InputJsonValue | undefined,
      })),
    });
  }

  const outcome: IngestOutcome = {
    statementId: statement.id,
    created: !existing,
    becamePaid,
    settled: 0,
    codRecorded: 0,
    discrepancies: 0,
    unmatched: 0,
    completed: 0,
    reconciledNow: false,
  };

  if (status === "PAID") {
    const open = await tx.courierStatementLine.findMany({
      where: { statementId: statement.id, status: { in: ["PENDING", "UNMATCHED", "MISMATCH"] } },
      orderBy: { lineNo: "asc" },
    });
    const lineCount = await tx.courierStatementLine.count({ where: { statementId: statement.id } });
    for (const line of open) {
      const verdict = await judgeLine(tx, statement, line, lineCount, actorId);
      if (verdict.status === "MATCHED") {
        outcome.settled += 1;
        outcome.codRecorded = round2(outcome.codRecorded + verdict.paid);
        if (verdict.completed) outcome.completed += 1;
      } else if (verdict.status === "MISMATCH") outcome.discrepancies += 1;
      else outcome.unmatched += 1;
    }
    outcome.reconciledNow = await finalizeStatement(tx, statement.id, actorId);
  }

  // The hourly sync re-reads every recent payout; only a real change is audit-worthy.
  const changed = outcome.created || outcome.becamePaid || outcome.settled > 0 || outcome.reconciledNow;
  if (changed) await writeAuditLogWith(tx, {
    actorId,
    action: existing ? "courier.statement.update" : "courier.statement.ingest",
    entityType: "courier_statement",
    entityId: statement.id,
    after: { reference: statement.reference, source: statement.source, status, ...amounts, lines: lines.length, ...outcome },
  });

  return outcome;
}

type StatementRow = Prisma.CourierStatementGetPayload<object>;
type LineRow = Prisma.CourierStatementLineGetPayload<object>;

const shipmentSelect = {
  id: true,
  courierId: true,
  zone: true,
  codAmount: true,
  codCollected: true,
  codReceivedAt: true,
  courierCostActual: true,
  courierCostEstimate: true,
  accountsReviewRequired: true,
  order: { select: { id: true, orderNo: true, status: true, dueAmount: true } },
} satisfies Prisma.ShipmentSelect;

type MatchedShipment = Prisma.ShipmentGetPayload<{ select: typeof shipmentSelect }>;

/** consignment id first (unique on shipments), then invoice = our order no. — both within this courier. */
async function matchLine(tx: Prisma.TransactionClient, courierId: string, line: LineRow): Promise<MatchedShipment | null> {
  if (line.consignmentId) {
    const s = await tx.shipment.findFirst({ where: { consignmentId: line.consignmentId, courierId }, select: shipmentSelect });
    if (s) return s;
  }
  if (line.invoice) {
    return tx.shipment.findFirst({ where: { courierId, bookedAt: { not: null }, order: { orderNo: line.invoice } }, select: shipmentSelect });
  }
  return null;
}

async function codFeePercentFor(tx: Prisma.TransactionClient, shipment: MatchedShipment): Promise<number> {
  if (!shipment.zone) return 1;
  const zone = await tx.courierZone.findUnique({ where: { courierId_zone: { courierId: shipment.courierId, zone: shipment.zone } }, select: { codChargePercent: true } });
  return zone ? toNumber(zone.codChargePercent) : 1;
}

async function judgeLine(
  tx: Prisma.TransactionClient,
  statement: StatementRow,
  line: LineRow,
  lineCount: number,
  actorId: string | null,
): Promise<{ status: "MATCHED" | "MISMATCH" | "UNMATCHED"; paid: number; completed: boolean }> {
  const shipment = await matchLine(tx, statement.courierId, line);
  if (!shipment) {
    await tx.courierStatementLine.update({ where: { id: line.id }, data: { status: "UNMATCHED", mismatchReason: "No shipment of ours has this consignment id or order no." } });
    return { status: "UNMATCHED", paid: 0, completed: false };
  }

  // What we expected the courier to collect: nothing for a parcel that came
  // back; what the rider reported collecting (partial delivery); else the
  // COD we booked.
  const returned = shipment.order.status === "RETURNED" || shipment.order.status === "REFUNDED";
  const ourCod = returned ? 0 : round2(toNumber(shipment.codCollected ?? shipment.codAmount));
  const theirGross = round2(toNumber(line.codAmount));
  const lineCharge = line.deliveryCharge == null ? null : toNumber(line.deliveryCharge);
  const feePct = await codFeePercentFor(tx, shipment);
  const expected = computeNetReceivable({
    codAmount: ourCod,
    courierCostActual: lineCharge ?? (shipment.courierCostActual == null ? null : toNumber(shipment.courierCostActual)),
    courierCostEstimate: shipment.courierCostEstimate == null ? null : toNumber(shipment.courierCostEstimate),
    codFeePercent: feePct,
  });
  // Their net for this parcel, when derivable: from its own charges, or — a
  // one-parcel statement — the statement's net itself. Otherwise the check
  // is at gross level here and at statement level in the report.
  let theirNet: number | null = null;
  if (lineCharge != null) {
    const fee = line.codCharge == null ? round2((Math.max(theirGross - lineCharge, 0) * feePct) / 100) : toNumber(line.codCharge);
    theirNet = round2(theirGross - lineCharge - fee);
  } else if (lineCount === 1 && (toNumber(statement.deliveryCharge) > 0 || toNumber(statement.codCharge) > 0)) {
    // Only when the statement states its charges — a COD-only CSV's "net" is
    // just gross carried over, not a figure the courier gave us.
    theirNet = round2(toNumber(statement.netAmount));
  }

  const judged = { shipmentId: shipment.id, orderId: shipment.order.id, ourCod, expectedNet: expected.netReceivable, paidNet: theirNet };

  let reason: string | null = null;
  const settledElsewhere = await tx.courierStatementLine.findFirst({
    where: { shipmentId: shipment.id, status: { in: [...SETTLED] }, id: { not: line.id } },
    select: { statement: { select: { reference: true } } },
  });
  if (settledElsewhere) reason = `Already settled by statement ${settledElsewhere.statement.reference} — paid twice?`;
  else if (!withinTolerance(theirGross, ourCod)) reason = `Courier says COD ${theirGross}, we expected ${ourCod}`;
  else if (theirNet != null && !withinTolerance(theirNet, expected.netReceivable)) {
    reason = `Courier paid net ${theirNet}, we expected ${expected.netReceivable} (charge ${expected.deliveryCharge}${expected.chargeKnown ? "" : " est."} + COD fee ${expected.codFee})`;
  }

  if (reason) {
    await tx.courierStatementLine.update({ where: { id: line.id }, data: { ...judged, status: "MISMATCH", mismatchReason: reason } });
    await tx.shipment.update({ where: { id: shipment.id }, data: { needsAttention: true, attentionReason: `COD payout mismatch (${statement.reference}): ${reason}` } });
    return { status: "MISMATCH", paid: 0, completed: false };
  }

  const { paid, completed } = await settleLine(tx, statement, line, shipment, theirGross, actorId);
  await tx.courierStatementLine.update({ where: { id: line.id }, data: { ...judged, status: "MATCHED", mismatchReason: null } });
  return { status: "MATCHED", paid, completed };
}

/**
 * Records the courier's COD against the order: a verified COURIER_COD
 * payment (capped at what is still due, so a stray figure can never push the
 * due negative), the shipment's COD marked received, then auto-complete.
 */
async function settleLine(
  tx: Prisma.TransactionClient,
  statement: StatementRow,
  line: LineRow,
  shipment: MatchedShipment,
  amount: number,
  actorId: string | null,
): Promise<{ paid: number; completed: boolean }> {
  const order = await tx.order.findUniqueOrThrow({ where: { id: shipment.order.id }, select: { id: true, orderNo: true, dueAmount: true } });
  const payAmount = round2(Math.min(amount, Math.max(toNumber(order.dueAmount), 0)));
  let paymentId: string | null = null;
  if (payAmount > 0) {
    const payment = await tx.payment.create({
      data: {
        orderId: order.id,
        amount: payAmount,
        method: "COURIER_COD",
        // No wallet: this money reaches the bank as the statement's net
        // payout (courier_statements.walletId), never parcel by parcel.
        // Globally unique (CLAUDE.md rule 4) and stable, so a replay can't double-pay.
        transactionId: `COD-${statement.reference}-${line.consignmentId ?? `L${line.lineNo}`}`.toUpperCase(),
        paidAt: statement.statementDate,
        receivedById: actorId,
        // The courier statement IS the evidence.
        verified: true,
        note: `Courier COD — statement ${statement.reference}`,
      },
    });
    paymentId = payment.id;
    await recomputeOrderDueAmount(tx, order.id);
    await writeAuditLogWith(tx, {
      actorId,
      action: "payment.create.courier_cod",
      entityType: "order",
      entityId: order.id,
      after: { paymentId, amount: payAmount, statement: statement.reference, consignmentId: line.consignmentId, lineNo: line.lineNo },
    });
  }
  await tx.courierStatementLine.update({ where: { id: line.id }, data: { paymentId } });
  await tx.shipment.update({ where: { id: shipment.id }, data: { codReceivedAt: statement.statementDate, needsAttention: false, attentionReason: null } });
  const completed = await autoCompleteOrder(tx, order.id, actorId, `Courier COD reconciled (statement ${statement.reference}) — completed`);
  return { paid: payAmount, completed };
}

/**
 * A money-justified order moves on to COMPLETED through the same
 * moveOrderStatus every transition uses: DELIVERED with nothing due, or a
 * PARTIAL_DELIVERED one with nothing due once Accounts has reviewed it.
 */
async function autoCompleteOrder(tx: Prisma.TransactionClient, orderId: string, actorId: string | null, note: string): Promise<boolean> {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { id: true, status: true, dueAmount: true, shipment: { select: { accountsReviewRequired: true } } } });
  if (toNumber(order.dueAmount) > 0) return false;
  const ready = order.status === "DELIVERED" || (order.status === "PARTIAL_DELIVERED" && !order.shipment?.accountsReviewRequired);
  if (!ready) return false;
  await moveOrderStatus(tx, { id: order.id, status: order.status, items: [] }, "COMPLETED", actorId, note);
  return true;
}

/**
 * Once every line is justified (MATCHED/ACCEPTED): post the statement's
 * charges as expenses — once, guarded by the unique FKs — and stamp it
 * reconciled. The delivery-charge expense excludes courier return charges
 * the condition check already posted for parcels on this statement, so a
 * returned parcel's charge is never booked twice (PRD §4.9 decision) — and,
 * the same way, company-borne exchange charges already posted (P3.2).
 * Returns true when it reconciled on this call.
 */
export async function finalizeStatement(tx: Prisma.TransactionClient, statementId: string, actorId: string | null): Promise<boolean> {
  const statement = await tx.courierStatement.findUniqueOrThrow({
    where: { id: statementId },
    include: { lines: { select: { status: true, shipmentId: true, deliveryCharge: true, shipment: { select: { orderId: true } } } } },
  });
  if (statement.status !== "PAID" || statement.reconciledAt) return false;
  const allJustified = statement.lines.length > 0 && statement.lines.every((l) => (SETTLED as readonly string[]).includes(l.status));
  if (!allJustified) return false;

  const shipmentIds = statement.lines.map((l) => l.shipmentId).filter((id): id is string => id !== null);
  // P3.2 — a company-borne exchange parcel paid out before its final status
  // reached us: its charge is final now. It posts under "Exchange / return
  // cost" at the charge on this line (once — a no-op for anything else or
  // anything already posted), and is left out of the delivery charge below.
  const orderIds = statement.lines.flatMap((l) => (l.shipment ? [l.shipment.orderId] : []));
  const unposted = await tx.returnCase.findMany({
    where: { replacementOrderId: { in: orderIds }, mode: "ONLINE", courierChargeBearer: "COMPANY", courierCostExpense: { is: null } },
    select: { replacementOrderId: true },
  });
  for (const { replacementOrderId } of unposted) {
    const line = statement.lines.find((l) => l.shipment?.orderId === replacementOrderId)!;
    await postExchangeCourierCost(tx, replacementOrderId!, actorId, { statementCharge: line.deliveryCharge });
  }
  const alreadyPostedReturnCharges = await tx.expense.aggregate({
    where: { returnChargeInspection: { shipmentId: { in: shipmentIds } }, deletedAt: null },
    _sum: { amount: true },
  });
  // P3.2 — a company-borne exchange parcel's charge already posted under
  // "Exchange / return cost" (lib/returns/exchange-courier-cost.ts).
  const alreadyPostedExchangeCharges = await tx.expense.aggregate({
    where: { exchangeCourierCase: { replacementOrder: { shipment: { id: { in: shipmentIds } } } }, deletedAt: null },
    _sum: { amount: true },
  });
  const alreadyPosted = toNumber(alreadyPostedReturnCharges._sum.amount ?? 0) + toNumber(alreadyPostedExchangeCharges._sum.amount ?? 0);
  const deliveryCharge = round2(Math.max(toNumber(statement.deliveryCharge) - alreadyPosted, 0));
  const codCharge = round2(toNumber(statement.codCharge));

  let deliveryChargeExpenseId = statement.deliveryChargeExpenseId;
  if (!deliveryChargeExpenseId && deliveryCharge > 0) {
    const expense = await tx.expense.create({
      data: {
        expenseDate: statement.statementDate,
        categoryId: await expenseCategoryId(tx, COURIER_DELIVERY_CHARGE_EXPENSE_CATEGORY, 12),
        nature: "VARIABLE",
        amount: deliveryCharge,
        note: `Courier statement ${statement.reference} — delivery charges`,
        createdById: actorId,
      },
    });
    deliveryChargeExpenseId = expense.id;
  }
  let codChargeExpenseId = statement.codChargeExpenseId;
  if (!codChargeExpenseId && codCharge > 0) {
    const expense = await tx.expense.create({
      data: {
        expenseDate: statement.statementDate,
        categoryId: await expenseCategoryId(tx, COD_CHARGE_EXPENSE_CATEGORY, 13),
        nature: "VARIABLE",
        amount: codCharge,
        note: `Courier statement ${statement.reference} — COD charges`,
        createdById: actorId,
      },
    });
    codChargeExpenseId = expense.id;
  }
  await tx.courierStatement.update({ where: { id: statement.id }, data: { reconciledAt: new Date(), deliveryChargeExpenseId, codChargeExpenseId } });
  return true;
}

/**
 * ACCOUNTS resolves a discrepancy. ACCEPT (reason required): the courier's
 * gross becomes the recorded COD — settled exactly like a match. DISPUTE
 * (note required): marked, nothing moves; the statement can't reconcile
 * around it until someone accepts it later.
 */
export async function resolveStatementLine(
  tx: Prisma.TransactionClient,
  input: { lineId: string; action: "ACCEPT" | "DISPUTE"; note: string },
  actorId: string,
): Promise<{ status: "ACCEPTED" | "DISPUTED"; reconciledNow: boolean; completed: boolean }> {
  const note = input.note.trim();
  if (note.length < 5) throw new ReconcileError("Write a short reason (at least 5 characters)");
  const line = await tx.courierStatementLine.findUnique({ where: { id: input.lineId }, include: { statement: true } });
  if (!line) throw new ReconcileError("Statement line not found");
  if (line.statement.status !== "PAID") throw new ReconcileError("This statement isn't paid yet");

  const resolved = { resolvedById: actorId, resolvedAt: new Date(), resolveNote: note };
  if (input.action === "DISPUTE") {
    if (!["MISMATCH", "UNMATCHED"].includes(line.status)) throw new ReconcileError("Only an open discrepancy can be disputed");
    await tx.courierStatementLine.update({ where: { id: line.id }, data: { status: "DISPUTED", ...resolved } });
    await writeAuditLogWith(tx, { actorId, action: "courier.statement_line.dispute", entityType: "courier_statement", entityId: line.statementId, after: { lineId: line.id, note } });
    return { status: "DISPUTED", reconciledNow: false, completed: false };
  }

  if (!["MISMATCH", "DISPUTED"].includes(line.status)) throw new ReconcileError("Only a mismatched or disputed line can be accepted");
  if (!line.shipmentId) throw new ReconcileError("This line isn't matched to one of our orders, so there's nothing to settle");
  const shipment = await tx.shipment.findUniqueOrThrow({ where: { id: line.shipmentId }, select: shipmentSelect });
  const settledElsewhere = await tx.courierStatementLine.findFirst({ where: { shipmentId: shipment.id, status: { in: [...SETTLED] }, id: { not: line.id } }, select: { id: true } });
  if (settledElsewhere) throw new ReconcileError("This parcel's COD was already settled by another statement line — dispute this one instead");

  // Claim first so a double click can't settle twice.
  const claimed = await tx.courierStatementLine.updateMany({ where: { id: line.id, status: { in: ["MISMATCH", "DISPUTED"] } }, data: { status: "ACCEPTED", ...resolved } });
  if (claimed.count !== 1) throw new ReconcileError("This line was just resolved by someone else");
  const { completed } = await settleLine(tx, line.statement, line, shipment, toNumber(line.codAmount), actorId);
  await writeAuditLogWith(tx, {
    actorId,
    action: "courier.statement_line.accept",
    entityType: "courier_statement",
    entityId: line.statementId,
    before: { status: line.status, mismatchReason: line.mismatchReason },
    after: { lineId: line.id, status: "ACCEPTED", note, acceptedCod: line.codAmount.toString() },
  });
  const reconciledNow = await finalizeStatement(tx, line.statementId, actorId);
  return { status: "ACCEPTED", reconciledNow, completed };
}
