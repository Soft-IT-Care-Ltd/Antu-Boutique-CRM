import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { courierPatchSchema, CourierSettingsError, updateCourier } from "@/lib/settings/couriers";

// Couriers are deactivated, never deleted — orders and shipments point at them.

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = courierPatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    return NextResponse.json({ courier: await updateCourier(prisma, guard.user.id, id, parsed.data, request) });
  } catch (error) {
    if (error instanceof CourierSettingsError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
