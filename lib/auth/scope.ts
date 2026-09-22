import type { SessionUser } from "@/lib/auth/types";

// Shared server-side query-scope helper (CLAUDE.md rule 6): a Sales
// Executive only ever sees records they created, a Team Leader only their
// team's. Every list/detail query for a scoped module MUST run its where
// clause through here — never hand-roll `createdById`/`teamId` filters
// per route, and never let a client-sent filter substitute for this.

export type ScopeConfig = {
  /** Field on the model holding the creating user's id. Default: "createdById". */
  ownerField?: string;
  /** Field on the model holding the team id. Default: "teamId". */
  teamField?: string;
};

/**
 * Returns the extra Prisma `where` clause a query MUST be AND-ed with for
 * this user's role. `{}` means "no extra restriction" (the role is trusted
 * with full visibility for whatever permission gated the route already).
 */
export function buildScopeWhere(
  user: SessionUser,
  config: ScopeConfig = {},
): Record<string, unknown> {
  const ownerField = config.ownerField ?? "createdById";
  const teamField = config.teamField ?? "teamId";

  switch (user.role) {
    case "SALES_EXECUTIVE":
    case "POS_OPERATOR":
      return { [ownerField]: user.id };
    case "TEAM_LEADER":
      return user.teamId ? { [teamField]: user.teamId } : { [ownerField]: user.id };
    default:
      return {};
  }
}

/**
 * Merges a caller-built `where` clause with the mandatory scope clause.
 * Scope is always AND-ed in last, so nothing the caller (or a client-sent
 * filter passed through into `where`) provides can widen it.
 */
export function scopedWhere<W extends Record<string, unknown>>(
  where: W,
  user: SessionUser,
  config: ScopeConfig = {},
): Record<string, unknown> {
  const scope = buildScopeWhere(user, config);
  if (Object.keys(scope).length === 0) return where;
  return { AND: [where, scope] };
}
