import "server-only";

import type { Prisma } from "@prisma/client";

import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import { computeNetReceivable, round2, statementIdentityHolds } from "@/lib/courier/payouts/net";
import type { AwaitingPayoutRow, CodSummary, StatementDetailView, StatementLineView, StatementRow } from "@/lib/courier/cod-types";
import { toNumber } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { onlineOrderCustomer } from "@/lib/orders/customer";

// Read side of COD reconciliation (PRD §4.9). Gated by courier.reconcile in
// the routes (ACCOUNTS / MANAGER / ADMIN). The courier's charges and our net
// receivable are shown here on purpose: reconciling the courier's payout is
// Accounts' job and needs them. They use their own field names
// (deliveryCharge / codFee / expectedNet), distinct from the shipment's
// courierCost* fields, which stay stripped for roles without product.cost.view.

const orderScope = (user: SessionUser): Prisma.OrderWhereInput => scopedWhere({ deletedAt: null }, user) as Prisma.OrderWhereInput;

const awaitingWhere = (user: SessionUser): Prisma.ShipmentWhereInput => ({
  deliveredAt: { not: null },
  codReceivedAt: null,
  order: { AND: [orderScope(user), { status: { in: ["DELIVERED", "PARTIAL_DELIVERED", "COMPLETED"] } }] },
});

const OPEN_LINE_STATUSES = ["MISMATCH", "UNMATCHED", "DISPUTED"] as const;

function dhakaMonthStartUtc(now = new Date()): Date {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit" }).format(now).split("-");
  return new Date(`${y}-${m}-01T00:00:00+06:00`);
}

async function feePercentByZone(): Promise<Map<string, number>> {
  const zones = await prisma.courierZone.findMany({ select: { courierId: true, zone: true, codChargePercent: true } });
  return new Map(zones.map((z) => [`${z.courierId}:${z.zone}`, toNumber(z.codChargePercent)]));
}

export async function listAwaitingPayout(user: SessionUser, opts: { page: number; pageSize: number }): Promise<{ items: AwaitingPayoutRow[]; total: number }> {
  const where = awaitingWhere(user);
  const [total, rows, fees] = await Promise.all([
    prisma.shipment.count({ where }),
    prisma.shipment.findMany({
      where,
      orderBy: { deliveredAt: "asc" },
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
      include: { courier: { select: { name: true } }, order: { select: { id: true, orderNo: true, status: true, customer: { select: { name: true } } } } },
    }),
    feePercentByZone(),
  ]);
  const now = Date.now();
  return {
    total,
    items: rows.map((s) => {
      const cod = toNumber(s.codCollected ?? s.codAmount);
      const net = computeNetReceivable({
        codAmount: cod,
        courierCostActual: s.courierCostActual == null ? null : toNumber(s.courierCostActual),
        courierCostEstimate: s.courierCostEstimate == null ? null : toNumber(s.courierCostEstimate),
        codFeePercent: s.zone ? (fees.get(`${s.courierId}:${s.zone}`) ?? 1) : 1,
      });
      return {
        shipmentId: s.id,
        orderId: s.order.id,
        orderNo: s.order.orderNo,
        orderStatus: s.order.status,
        customerName: onlineOrderCustomer(s.order).name,
        courierName: s.courier.name,
        consignmentId: s.consignmentId,
        codCollected: cod.toFixed(2),
        deliveryCharge: net.deliveryCharge.toFixed(2),
        chargeKnown: net.chargeKnown,
        codFee: net.codFee.toFixed(2),
        expectedNet: net.netReceivable.toFixed(2),
        deliveredAt: s.deliveredAt!.toISOString(),
        daysWaiting: Math.floor((now - s.deliveredAt!.getTime()) / 86_400_000),
      };
    }),
  };
}

function serializeStatement(s: Prisma.CourierStatementGetPayload<{ include: typeof statementListInclude }>): StatementRow {
  const gross = toNumber(s.grossAmount);
  const deliveryCharge = toNumber(s.deliveryCharge);
  const codCharge = toNumber(s.codCharge);
  const net = toNumber(s.netAmount);
  return {
    id: s.id,
    courierName: s.courier.name,
    source: s.source,
    reference: s.reference,
    status: s.status,
    statementDate: s.statementDate.toISOString(),
    grossAmount: gross.toFixed(2),
    deliveryCharge: deliveryCharge.toFixed(2),
    codCharge: codCharge.toFixed(2),
    netAmount: net.toFixed(2),
    walletName: s.wallet?.name ?? null,
    identityHolds: statementIdentityHolds({ grossAmount: gross, deliveryCharge, codCharge, netAmount: net }),
    lineCount: s.lines.length,
    settledCount: s.lines.filter((l) => l.status === "MATCHED" || l.status === "ACCEPTED").length,
    openCount: s.lines.filter((l) => (OPEN_LINE_STATUSES as readonly string[]).includes(l.status)).length,
    reconciledAt: s.reconciledAt?.toISOString() ?? null,
  };
}

const statementListInclude = { courier: { select: { name: true } }, wallet: { select: { name: true } }, lines: { select: { status: true } } } as const;

export async function listStatements(opts: { page: number; pageSize: number }): Promise<{ items: StatementRow[]; total: number }> {
  const [total, rows] = await Promise.all([
    prisma.courierStatement.count(),
    prisma.courierStatement.findMany({ orderBy: { statementDate: "desc" }, skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize, include: statementListInclude }),
  ]);
  return { total, items: rows.map(serializeStatement) };
}

const lineInclude = {
  order: { select: { id: true, orderNo: true, status: true } },
  statement: { select: { id: true, reference: true, statementDate: true, courier: { select: { name: true } } } },
  resolvedBy: { select: { name: true } },
} satisfies Prisma.CourierStatementLineInclude;

function serializeLine(l: Prisma.CourierStatementLineGetPayload<{ include: typeof lineInclude }>): StatementLineView {
  return {
    id: l.id,
    lineNo: l.lineNo,
    statementId: l.statement.id,
    statementReference: l.statement.reference,
    courierName: l.statement.courier.name,
    consignmentId: l.consignmentId,
    invoice: l.invoice,
    codAmount: l.codAmount.toString(),
    deliveryCharge: l.deliveryCharge?.toString() ?? null,
    orderId: l.order?.id ?? null,
    orderNo: l.order?.orderNo ?? null,
    orderStatus: l.order?.status ?? null,
    status: l.status,
    ourCod: l.ourCod?.toString() ?? null,
    expectedNet: l.expectedNet?.toString() ?? null,
    paidNet: l.paidNet?.toString() ?? null,
    mismatchReason: l.mismatchReason,
    settled: l.paymentId !== null || l.status === "MATCHED" || l.status === "ACCEPTED",
    resolvedBy: l.resolvedBy?.name ?? null,
    resolvedAt: l.resolvedAt?.toISOString() ?? null,
    resolveNote: l.resolveNote,
  };
}

export async function loadStatementDetail(id: string): Promise<StatementDetailView | null> {
  const s = await prisma.courierStatement.findUnique({
    where: { id },
    include: { ...statementListInclude, lines: { orderBy: { lineNo: "asc" }, include: lineInclude } },
  });
  if (!s) return null;
  const lines = s.lines.map(serializeLine);
  const judged = s.lines.filter((l) => l.expectedNet !== null);
  const expectedNetSum = judged.length ? round2(judged.reduce((sum, l) => sum + toNumber(l.expectedNet!), 0)) : null;
  const fullyJudged = judged.length === s.lines.length && s.lines.length > 0;
  return {
    ...serializeStatement(s),
    note: s.note,
    expectedNetSum: expectedNetSum?.toFixed(2) ?? null,
    // Statement-level justification: what they paid vs what our books say they owed.
    paidVsExpectedDiff: fullyJudged && expectedNetSum !== null ? round2(toNumber(s.netAmount) - expectedNetSum).toFixed(2) : null,
    lines,
  };
}

export async function listDiscrepancies(opts: { page: number; pageSize: number }): Promise<{ items: StatementLineView[]; total: number }> {
  const where: Prisma.CourierStatementLineWhereInput = { status: { in: [...OPEN_LINE_STATUSES] }, statement: { status: "PAID" } };
  const [total, rows] = await Promise.all([
    prisma.courierStatementLine.count({ where }),
    prisma.courierStatementLine.findMany({ where, orderBy: [{ statement: { statementDate: "desc" } }, { lineNo: "asc" }], skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize, include: lineInclude }),
  ]);
  return { total, items: rows.map(serializeLine) };
}

export async function codSummary(user: SessionUser): Promise<CodSummary> {
  const [awaiting, open, collected, integration] = await Promise.all([
    prisma.shipment.findMany({ where: awaitingWhere(user), select: { codAmount: true, codCollected: true } }),
    prisma.courierStatementLine.count({ where: { status: { in: [...OPEN_LINE_STATUSES] }, statement: { status: "PAID" } } }),
    prisma.payment.aggregate({ where: { method: "COURIER_COD", paidAt: { gte: dhakaMonthStartUtc() }, order: orderScope(user) }, _sum: { amount: true } }),
    prisma.courierIntegration.findUnique({ where: { provider: "STEADFAST" }, select: { lastPaymentsSyncAt: true, isEnabled: true } }),
  ]);
  return {
    awaitingCount: awaiting.length,
    awaitingCod: round2(awaiting.reduce((sum, s) => sum + toNumber(s.codCollected ?? s.codAmount), 0)).toFixed(2),
    openDiscrepancies: open,
    collectedThisMonth: toNumber(collected._sum.amount ?? 0).toFixed(2),
    lastPayoutsSyncAt: integration?.lastPaymentsSyncAt?.toISOString() ?? null,
    steadfastEnabled: integration?.isEnabled ?? false,
  };
}
