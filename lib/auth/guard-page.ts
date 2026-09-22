import "server-only";

import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { can } from "@/lib/auth/permissions";
import { getRequiredPermission } from "@/lib/nav-config";
import type { SessionUser } from "@/lib/auth/types";

// The sidebar only *hides* items a role can't use — it is not the security
// boundary (see the comment on navGroups in lib/nav-config.ts). Every
// dashboard module page calls this at the top so navigating straight to the
// URL is gated the same way the nav is, off the same permission map.
export async function guardPage(pathname: string): Promise<SessionUser> {
  const session = await auth();
  const sessionUser = session?.user;
  if (!sessionUser) redirect(`/login?callbackUrl=${encodeURIComponent(pathname)}`);

  const user: SessionUser = { id: sessionUser.id, role: sessionUser.role, teamId: sessionUser.teamId };

  const required = getRequiredPermission(pathname);
  if (required && !(await can(user, required))) {
    redirect("/dashboard");
  }

  return user;
}
