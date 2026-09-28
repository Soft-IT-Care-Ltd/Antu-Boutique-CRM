import { auth } from "@/auth";
import { AppSidebar } from "@/components/app-shell/app-sidebar";
import { BackupBanner } from "@/components/app-shell/backup-banner";
import { Topbar } from "@/components/app-shell/topbar";
import { ListPrefsProvider } from "@/components/list/list-prefs";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import type { PermissionKey } from "@/lib/auth/permission-definitions";
import { getEffectivePermissions } from "@/lib/auth/permissions";
import { getListPageSizes } from "@/lib/list/prefs";
import { prisma } from "@/lib/prisma";
import { getBackupHealth } from "@/lib/system/jobs";

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
  // CORRECTIONS.md item 15 — each list opens at the page size this person picked.
  const pageSizes = session?.user ? await getListPageSizes(prisma, session.user.id) : {};

  // PRD §4.18 backup alert, for whoever looks after Settings. A dev machine
  // that has never run a backup isn't nagged; production always is.
  const backup = permissions.has("settings.manage") ? await getBackupHealth(prisma) : null;
  const showBackupBanner = backup !== null && (backup.state === "stale" || (backup.state === "never" && process.env.NODE_ENV === "production"));

  return (
    <ListPrefsProvider initial={pageSizes}>
      <SidebarProvider>
        <AppSidebar permissions={[...permissions]} />
        {/* min-w-0: a flex child otherwise grows to its widest content, so one
            wide table pushed the whole page past the screen edge on a tablet. */}
        <SidebarInset className="min-w-0">
          <Topbar userName={userName} userRole={userRole} isPreview={isPreview} />
          {showBackupBanner ? <BackupBanner health={backup} /> : null}
          <div className="flex flex-1 flex-col">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </ListPrefsProvider>
  );
}
