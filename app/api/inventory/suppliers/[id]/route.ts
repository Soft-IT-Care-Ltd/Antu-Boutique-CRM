import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";

// Suppliers are never deleted — their purchases (and the stock those moved)
// reference them forever. Deactivating hides them from the purchase form.
const patchSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  phone: z.string().trim().max(30).nullish(),
  address: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  isActive: z.boolean().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("inventory.purchase.create");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const before = await prisma.supplier.findUnique({ where: { id } });
  if (!before) return NextResponse.json({ error: "Supplier not found" }, { status: 404 });

  const data = parsed.data;
  try {
    const supplier = await prisma.supplier.update({
      where: { id },
      data: {
        name: data.name,
        phone: data.phone === undefined ? undefined : data.phone || null,
        address: data.address === undefined ? undefined : data.address || null,
        notes: data.notes === undefined ? undefined : data.notes || null,
        isActive: data.isActive,
      },
    });
    await writeAuditLog({ actorId: guard.user.id, action: "supplier.update", entityType: "supplier", entityId: id, before, after: supplier, request });
    return NextResponse.json({ supplier });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "A supplier with this name already exists" }, { status: 409 });
    }
    throw err;
  }
}
