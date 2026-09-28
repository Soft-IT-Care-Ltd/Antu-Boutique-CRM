import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { locationInputSchema, saveLocation } from "@/lib/locations/admin";
import { LocationError } from "@/lib/locations/service";
import { prisma } from "@/lib/prisma";

// CORRECTIONS.md item 2 — edit a location, its hub/POS flags and its managers.

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const parsed = locationInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  try {
    return NextResponse.json(await saveLocation(prisma, id, parsed.data, guard.user.id, request));
  } catch (error) {
    if (error instanceof LocationError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
