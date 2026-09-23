import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { markAccountsReviewed } from "@/lib/courier/partial-delivery";
import { courierErrorResponse, zodError } from "@/lib/courier/route-errors";
import { prisma } from "@/lib/prisma";

// ACCOUNTS clears the partial-delivery money flag (audit-logged in the service).
const bodySchema = z.object({ note: z.string().trim().max(500).optional() });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("courier.reconcile");
  if (!guard.ok) return guard.response;
  const { id } = await params;

  const parsed = bodySchema.safeParse((await request.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return zodError(parsed.error.issues);

  const visible = await prisma.shipment.findFirst({ where: { id, order: scopedWhere({ deletedAt: null }, guard.user) }, select: { id: true } });
  if (!visible) return NextResponse.json({ error: "Shipment not found" }, { status: 404 });

  try {
    await prisma.$transaction((tx) => markAccountsReviewed(tx, id, guard.user.id, parsed.data.note));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return courierErrorResponse(error);
  }
}
