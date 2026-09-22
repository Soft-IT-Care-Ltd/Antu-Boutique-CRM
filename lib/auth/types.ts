import type { RoleName } from "@prisma/client";

// The shape every permission/scope helper needs — satisfied by both the
// NextAuth session user and a raw Prisma user row.
export type SessionUser = {
  id: string;
  role: RoleName;
  teamId: string | null;
};
