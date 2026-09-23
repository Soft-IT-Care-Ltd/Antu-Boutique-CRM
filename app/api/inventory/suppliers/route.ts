import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { PURCHASE_VIEW_PERMISSIONS, listSuppliers } from "@/lib/inventory/queries";

const querySchema = z.object({
  q: z.string().trim().max(100).optional(),
  includeInactive: z.enum(["true", "false"]).optional(),
});

const supplierBodySchema = z.object({
  name: z.string().trim().min(1, "Supplier name is required").max(150),
  phone: z.string().trim().max(30).nullish(),
  address: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(2000).nullish(),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission(PURCHASE_VIEW_PERMISSIONS, "all");
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  }

  const suppliers = await listSuppliers({ q: parsed.data.q || undefined, includeInactive: parsed.data.includeInactive === "true" });
  return NextResponse.json({ suppliers });
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("inventory.purchase.create");
  if (!guard.ok) return guard.response;

  const parsed = supplierBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  try {
    const supplier = await prisma.supplier.create({
      data: {
        name: parsed.data.name,
        phone: parsed.data.phone || null,
        address: parsed.data.address || null,
        notes: parsed.data.notes || null,
      },
    });
    await writeAuditLog({ actorId: guard.user.id, action: "supplier.create", entityType: "supplier", entityId: supplier.id, after: supplier, request });
    return NextResponse.json({ supplier }, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "A supplier with this name already exists" }, { status: 409 });
    }
    throw err;
  }
}
