import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import type { PermissionKey } from "@/lib/auth/permission-definitions";

const VIEW_PERMISSIONS: PermissionKey[] = ["order.view_own", "order.view_team", "order.view_all"];

// Feeds the order list's "SE" filter (PRD build order for P1.3: "order list
// with filters (status, SE, date, channel)"). Deliberately scoped exactly
// like the order list itself rather than a general user directory — a TL
// only ever needs to filter by their own team's creators, an SE has no use
// for this dropdown at all (their list is already narrowed to themself).
export async function GET() {
  const guard = await requirePermission(VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;

  const orders = await prisma.order.findMany({
    where: scopedWhere({ deletedAt: null, createdById: { not: null } }, guard.user),
    select: { createdBy: { select: { id: true, name: true } } },
    distinct: ["createdById"],
  });

  const users = orders
    .map((o) => o.createdBy)
    .filter((u): u is { id: string; name: string } => Boolean(u))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ users });
}
