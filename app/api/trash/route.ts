import { NextResponse, type NextRequest } from "next/server";

import { getEffectivePermissions } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { listTrash, TRASH_PERMISSIONS, trashQuerySchema, visibleTrashKinds } from "@/lib/trash/queries";

// PRD §4.18 — what's in the trash, one kind at a time (?kind=order|customer|
// product|lead&q=&page=). Each kind needs its delete permission and is
// scoped like its own list (lib/trash/queries.ts).
export async function GET(request: NextRequest) {
  const guard = await requirePermission(Object.values(TRASH_PERMISSIONS));
  if (!guard.ok) return guard.response;

  const parsed = trashQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid filter" }, { status: 400 });

  const kinds = visibleTrashKinds(await getEffectivePermissions(guard.user.id));
  if (parsed.data.kind && !kinds.includes(parsed.data.kind)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json(await listTrash(prisma, guard.user, kinds, parsed.data));
}
