import type { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { toNumber } from "@/lib/money";
import { EXCHANGE_COURIER_EXPENSE_CATEGORY_ID } from "@/lib/returns/constants";

// PRD §4.11 + §4.12 (P3.2 decision): when the COMPANY bears the courier
// charge of an online exchange, that charge is an exchange cost. It posts
// once, under "Exchange / return cost", when the replacement parcel's charge
// is final (the shipment finalizes: delivered, partly delivered or
// returned). Amount: the courier's own charge for the parcel, else our
// estimate. If the courier pays the parcel out before its final status
// reaches us, the statement's reconciliation posts it instead, at the charge
// the statement line shows (lib/courier/reconcile.ts finalizeStatement).
//
// The P&L rule: every courier charge reaches P&L exactly once. A reconciled
// Steadfast statement already expenses this parcel's delivery charge under
// Courier, so:
//   - posting here skips a parcel whose payout was already reconciled, and
//   - the statement's delivery-charge expense leaves out what was posted
//     here first (lib/courier/reconcile.ts finalizeStatement).
// Same shape as the courier return charge (lib/returns/condition-check.ts).

export async function postExchangeCourierCost(
  tx: Prisma.TransactionClient,
  replacementOrderId: string,
  actorId: string | null,
  opts: { statementCharge?: Prisma.Decimal | null } = {},
): Promise<string | null> {
  const returnCase = await tx.returnCase.findUnique({
    where: { replacementOrderId },
    select: {
      id: true,
      mode: true,
      courierChargeBearer: true,
      courierCostExpense: { select: { id: true } },
      order: { select: { orderNo: true } },
      replacementOrder: { select: { orderNo: true, shipment: { select: { id: true, courierCostActual: true, courierCostEstimate: true } } } },
    },
  });
  if (!returnCase || returnCase.mode !== "ONLINE" || returnCase.courierChargeBearer !== "COMPANY" || returnCase.courierCostExpense) return null;
  const shipment = returnCase.replacementOrder?.shipment;
  if (!shipment) return null;

  const expensedByStatement = await tx.courierStatementLine.findFirst({
    where: { shipmentId: shipment.id, status: { in: ["MATCHED", "ACCEPTED"] }, statement: { reconciledAt: { not: null } } },
    select: { id: true },
  });
  if (expensedByStatement) return null;

  const amount = opts.statementCharge ?? shipment.courierCostActual ?? shipment.courierCostEstimate;
  if (amount === null || toNumber(amount) <= 0) return null;

  await tx.expense.create({
    data: {
      expenseDate: new Date(),
      categoryId: EXCHANGE_COURIER_EXPENSE_CATEGORY_ID,
      nature: "VARIABLE",
      amount,
      note: `Exchange courier charge (we pay) — ${returnCase.replacementOrder!.orderNo}, exchange for ${returnCase.order.orderNo}`,
      exchangeCourierCaseId: returnCase.id,
      createdById: actorId,
    },
  });
  await writeAuditLogWith(tx, {
    actorId,
    action: "exchange.courier_cost.post",
    entityType: "order",
    entityId: replacementOrderId,
    after: { caseId: returnCase.id, amount: amount.toString(), actual: opts.statementCharge != null || shipment.courierCostActual !== null, via: opts.statementCharge != null ? "courier_statement" : "shipment_final" },
  });
  return amount.toString();
}
