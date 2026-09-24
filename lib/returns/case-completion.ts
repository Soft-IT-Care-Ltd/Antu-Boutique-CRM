import type { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { formatBDT } from "@/lib/money";
import { moveOrderStatus } from "@/lib/orders/lifecycle";
import { issueStoreCredit } from "@/lib/store-credit/ledger";

// PRD §4.11 / CORRECTIONS 6n: a return or exchange stays open until the
// item is physically back and Packing has checked it. Called by the
// condition-check service (lib/returns/condition-check.ts) the moment an
// inspection completes, in the same transaction: the case it belongs to
// completes, and an exchanged order whose last open exchange this was moves
// EXCHANGE_REQUESTED → COMPLETED.
//
// P3.2 — a case settled as STORE_CREDIT credits the customer now, with the
// item back: what approval left owed (owedAmount), capped at what the order
// is still overpaid after any refund already paid or pending — so nothing
// goes back twice. A fully returned order then counts as REFUNDED, as an
// approved refund would make it.

export async function completeReturnCaseAfterCheck(tx: Prisma.TransactionClient, inspectionId: string, actorId: string | null): Promise<void> {
  const returnCase = await tx.returnCase.findUnique({
    where: { inspectionId },
    select: {
      id: true,
      type: true,
      status: true,
      orderId: true,
      settlement: true,
      owedAmount: true,
      order: { select: { orderNo: true, status: true, customerId: true } },
    },
  });
  // Counter cases are created COMPLETED, with their check done on the spot.
  if (!returnCase || returnCase.status !== "APPROVED") return;

  const claimed = await tx.returnCase.updateMany({ where: { id: returnCase.id, status: "APPROVED" }, data: { status: "COMPLETED", completedAt: new Date() } });
  if (claimed.count !== 1) return;

  let storeCreditIssued = 0;
  if (returnCase.settlement === "STORE_CREDIT" && returnCase.order.customerId && returnCase.owedAmount) {
    const [order, pending] = await Promise.all([
      tx.order.findUniqueOrThrow({ where: { id: returnCase.orderId }, select: { dueAmount: true } }),
      tx.payment.aggregate({ where: { orderId: returnCase.orderId, kind: "REFUND", refundStatus: "PENDING" }, _sum: { amount: true } }),
    ]);
    // Pending refunds are negative and not yet in due_amount.
    const overpaid = -toPaisa(order.dueAmount) + toPaisa(pending._sum.amount ?? 0);
    storeCreditIssued = Math.max(0, Math.min(toPaisa(returnCase.owedAmount), overpaid));
    if (storeCreditIssued > 0) {
      await issueStoreCredit(tx, {
        customerId: returnCase.order.customerId,
        orderId: returnCase.orderId,
        amountPaisa: storeCreditIssued,
        returnCaseId: returnCase.id,
        reason: `${returnCase.type === "EXCHANGE" ? "Exchange" : "Return"} on ${returnCase.order.orderNo}: ${formatBDT(fromPaisa(storeCreditIssued))} back as store credit`,
        actorId,
      });
      if (returnCase.type === "RETURN" && returnCase.order.status === "RETURNED") {
        await moveOrderStatus(tx, { id: returnCase.orderId, status: "RETURNED", items: [] }, "REFUNDED", actorId, "Returned — the money went back as store credit");
      }
    }
  }

  let orderCompleted = false;
  if (returnCase.type === "EXCHANGE" && returnCase.order.status === "EXCHANGE_REQUESTED") {
    const stillOpen = await tx.returnCase.count({ where: { orderId: returnCase.orderId, type: "EXCHANGE", status: "APPROVED" } });
    if (stillOpen === 0) {
      await moveOrderStatus(tx, { id: returnCase.orderId, status: "EXCHANGE_REQUESTED", items: [] }, "COMPLETED", actorId, "Exchange complete — the returned item passed its condition check");
      orderCompleted = true;
    }
  }

  await writeAuditLogWith(tx, {
    actorId,
    action: returnCase.type === "EXCHANGE" ? "exchange.complete" : "return.complete",
    entityType: "order",
    entityId: returnCase.orderId,
    before: { caseId: returnCase.id, status: "APPROVED" },
    after: { caseId: returnCase.id, status: "COMPLETED", inspectionId, orderCompleted, storeCreditIssued: fromPaisa(storeCreditIssued) },
  });
}
