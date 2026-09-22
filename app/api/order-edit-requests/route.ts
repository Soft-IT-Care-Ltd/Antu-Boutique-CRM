import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { ORDER_EDIT_REQUEST_STATUS_VALUES } from "@/lib/orders/constants";

// Inbox for the same permission that lets someone bypass the edit window
// directly (lib/orders/apply-edit.ts + the order PATCH route's gating) —
// "can edit past the window" and "can approve someone else doing the same"
// are the same authority. A Team Leader only sees their own team's orders
// here, same scoping rule as everywhere else (CLAUDE.md rule 6).
const querySchema = z.object({
  status: z.enum(ORDER_EDIT_REQUEST_STATUS_VALUES).default("PENDING"),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission("order.edit_after_window");
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  }

  const requests = await prisma.orderEditRequest.findMany({
    where: {
      status: parsed.data.status,
      order: scopedWhere({ deletedAt: null }, guard.user),
    },
    include: {
      order: { select: { id: true, orderNo: true, status: true, customer: { select: { name: true, phone: true } } } },
      requestedBy: { select: { id: true, name: true } },
      reviewedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    items: requests.map((r) => ({
      id: r.id,
      status: r.status,
      order: r.order,
      proposedChanges: r.proposedChanges,
      requestedBy: r.requestedBy,
      reviewedBy: r.reviewedBy,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      reviewNote: r.reviewNote,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}
