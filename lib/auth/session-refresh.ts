import type { RoleName } from "@prisma/client";

import type { Db } from "@/lib/db/tx";

// Every authenticated request re-checks the signed-in user against the
// database (auth.ts `jwt` callback → here). The JWT is only a pointer; the
// users table is the truth:
//   - user deleted or deactivated → null → Auth.js drops the session, so the
//     user is signed out on their very next request
//   - role / team / must-change-password changed → the token is refreshed
//     now, so scoping (lib/auth/scope.ts reads session role + team) and the
//     forced password change take effect immediately, not at next login
// Deliberately free of next-auth imports so it runs under vitest.

export type SessionTokenFields = {
  id?: string;
  role?: RoleName;
  teamId?: string | null;
  mustChangePassword?: boolean;
};

export async function refreshSessionToken<T extends SessionTokenFields>(db: Db, token: T): Promise<T | null> {
  if (!token.id) return null;
  const user = await db.user.findUnique({
    where: { id: token.id },
    select: { isActive: true, teamId: true, mustChangePassword: true, role: { select: { name: true } } },
  });
  if (!user || !user.isActive) return null;
  return { ...token, role: user.role.name, teamId: user.teamId, mustChangePassword: user.mustChangePassword };
}
