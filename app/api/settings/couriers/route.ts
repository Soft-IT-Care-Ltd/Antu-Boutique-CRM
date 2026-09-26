import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { courierSchema, CourierSettingsError, createCourier, listCourierSettings } from "@/lib/settings/couriers";

// Settings → Couriers & zones (PRD §4.17). Customer-facing delivery charges
// only — no cost data here, so settings.manage alone gates it.

export async function GET() {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  return NextResponse.json({ couriers: await listCourierSettings(prisma) });
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  const parsed = courierSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    return NextResponse.json({ courier: await createCourier(prisma, guard.user.id, parsed.data, request) }, { status: 201 });
  } catch (error) {
    if (error instanceof CourierSettingsError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
