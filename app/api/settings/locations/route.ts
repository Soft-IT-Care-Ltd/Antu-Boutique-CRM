import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { listLocationSettings, locationInputSchema, saveLocation } from "@/lib/locations/admin";
import { LocationError } from "@/lib/locations/service";
import { prisma } from "@/lib/prisma";

// CORRECTIONS.md item 2 — Settings → Locations (settings.manage).

export async function GET() {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  return NextResponse.json(await listLocationSettings(prisma));
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  const parsed = locationInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  try {
    return NextResponse.json(await saveLocation(prisma, null, parsed.data, guard.user.id, request), { status: 201 });
  } catch (error) {
    if (error instanceof LocationError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
