import { auth } from "@/auth";
import { AppSidebar } from "@/components/app-shell/app-sidebar";
import { Topbar } from "@/components/app-shell/topbar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import type { PermissionKey } from "@/lib/auth/permission-definitions";
import { getEffectivePermissions } from "@/lib/auth/permissions";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  const userName = session?.user?.name ?? "Preview User";
  const userRole = session?.user?.role ?? "No role — not signed in";
  const isPreview = !session;

  // Icons in nav-config are component references, which can't cross the
  // server/client boundary as props — only the (serializable) permission
  // keys do. AppSidebar imports navGroups itself and filters client-side.
  const permissions = session?.user
    ? await getEffectivePermissions(session.user.id)
    : new Set<PermissionKey>();

  return (
    <SidebarProvider>
      <AppSidebar permissions={[...permissions]} />
      {/* min-w-0: a flex child otherwise grows to its widest content, so one
          wide table pushed the whole page past the screen edge on a tablet. */}
      <SidebarInset className="min-w-0">
        <Topbar userName={userName} userRole={userRole} isPreview={isPreview} />
        <div className="flex flex-1 flex-col">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
