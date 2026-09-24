import type { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { moveOrderStatus } from "@/lib/orders/lifecycle";

// PRD §4.11 / CORRECTIONS 6n: a return or exchange stays open until the
// item is physically back and Packing has checked it. Called by the
// condition-check service (lib/returns/condition-check.ts) the moment an
// inspection completes, in the same transaction: the case it belongs to
// completes, and an exchanged order whose last open exchange this was moves
// EXCHANGE_REQUESTED → COMPLETED.

export async function completeReturnCaseAfterCheck(tx: Prisma.TransactionClient, inspectionId: string, actorId: string | null): Promise<void> {
  const returnCase = await tx.returnCase.findUnique({
    where: { inspectionId },
    select: { id: true, type: true, status: true, orderId: true, order: { select: { orderNo: true, status: true } } },
  });
  // Counter cases are created COMPLETED, with their check done on the spot.
  if (!returnCase || returnCase.status !== "APPROVED") return;

  const claimed = await tx.returnCase.updateMany({ where: { id: returnCase.id, status: "APPROVED" }, data: { status: "COMPLETED", completedAt: new Date() } });
  if (claimed.count !== 1) return;

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
    after: { caseId: returnCase.id, status: "COMPLETED", inspectionId, orderCompleted },
  });
}
