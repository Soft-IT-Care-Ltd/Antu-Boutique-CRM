import type { ReactNode } from "react";

import { auth } from "@/auth";
import { can } from "@/lib/auth/permissions";
import type { PermissionKey } from "@/lib/auth/permission-definitions";

type CanProps = {
  permission: PermissionKey | PermissionKey[];
  mode?: "any" | "all";
  fallback?: ReactNode;
  children: ReactNode;
};

/** Server-side permission gate for UI. Renders `children` only if the signed-in user holds `permission`. */
export async function Can({ permission, mode = "any", fallback = null, children }: CanProps) {
  const session = await auth();
  const sessionUser = session?.user;
  if (!sessionUser) return <>{fallback}</>;

  const allowed = await can(
    { id: sessionUser.id, role: sessionUser.role, teamId: sessionUser.teamId },
    permission,
    mode,
  );

  return <>{allowed ? children : fallback}</>;
}
