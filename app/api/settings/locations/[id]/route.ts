import { NextResponse, type NextRequest } from "next/server";

import { can } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/require-permission";
import { locationInputSchema, saveLocation, ShelvesOffConfirmError } from "@/lib/locations/admin";
import { LocationError } from "@/lib/locations/service";
import { prisma } from "@/lib/prisma";

// CORRECTIONS.md item 2 — edit a location, its hub/POS flags and its managers.
// Switching shelves off is Admin only (shelf.switch_off) and must confirm
// exactly what it erases; a missing or stale confirmation gets 409 with
// the current count to show.

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = locationInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  try {
    return NextResponse.json(await saveLocation(prisma, id, parsed.data, guard.user.id, request, { canSwitchShelvesOff: await can(guard.user, "shelf.switch_off") }));
  } catch (error) {
    if (error instanceof ShelvesOffConfirmError) return NextResponse.json({ error: error.message, confirmShelvesOff: error.count }, { status: 409 });
    if (error instanceof LocationError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
