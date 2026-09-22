import "server-only";

import { can } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/types";

type OrderOwnership = { createdById: string | null; teamId: string | null };

// Same visibility rule the order.view_* permissions + scopedWhere() already
// enforce for list/detail queries, factored out so the auth-checked uploads
// route (app/uploads/[...path]/route.ts) can apply the identical check to a
// single order's reference images without re-querying with a `where` clause
// (it only has the order row, not a Prisma query to scope).
export async function canViewOrder(user: SessionUser, order: OrderOwnership): Promise<boolean> {
  if (await can(user, "order.view_all")) return true;
  // PRD §4.8: Packing works every order regardless of who created it, but
  // (deliberately) holds none of order.view_own/team/all — see the comment
  // on ROLE_TEMPLATES.PACKING. Its queue/detail screens need to render
  // reference-image thumbnails for any order, so packing.view_queue grants
  // that one slice of order.view_all (images only, no money) here.
  if (await can(user, "packing.view_queue")) return true;
  if (await can(user, "order.view_team")) return Boolean(user.teamId) && order.teamId === user.teamId;
  if (await can(user, "order.view_own")) return order.createdById === user.id;
  return false;
}

// PRD §4.6 section 3: "Upload/replace/delete limited to the order's SE,
// their TL, and Admin." This is ownership-scoped (a TL only for THEIR team,
// an SE only for THEIR OWN order), not a flat permission grant, so it lives
// here as the one centralized place this rule is decided — every route that
// mutates order images must call this rather than re-deriving it.
export function canManageOrderImages(user: SessionUser, order: OrderOwnership): boolean {
  if (user.role === "ADMIN") return true;
  if (order.createdById === user.id) return true;
  if (user.role === "TEAM_LEADER" && Boolean(user.teamId) && order.teamId === user.teamId) return true;
  return false;
}
