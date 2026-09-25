import "server-only";

import { getEffectivePermissions } from "@/lib/auth/permissions";
import type { PermissionKey } from "@/lib/auth/permission-definitions";
import type { SessionUser } from "@/lib/auth/types";

// P4.3 (PRD §4.16) — which dashboard a user gets, decided by permissions
// (lib/auth/permissions.ts), never by comparing role names. The role
// templates make this the PRD's mapping — Admin/Manager → the owner's view,
// Sales Executive / Team Leader → sales, Packing → packing, Accounts →
// accounts — and a per-user override moves someone with it.

export type DashboardPanels = {
  /** Whole-shop numbers with cost and profit. */
  owner: boolean;
  /** My (or my team's) leads, follow-ups, orders and target. */
  sales: boolean;
  packing: boolean;
  accounts: boolean;
  /** The showroom till's own sales today (no PRD panel — so the POS login isn't blank). */
  counter: boolean;
  /** Pieces several dashboards use. */
  can: {
    leads: boolean;
    targets: boolean;
    attendanceMark: boolean;
    attendanceBoard: boolean;
    payments: boolean;
    wallets: boolean;
    expenses: boolean;
    cod: boolean;
    inventory: boolean;
  };
};

const OWNER_NEEDS: PermissionKey[] = ["report.pl.view", "product.cost.view", "order.view_all"];

export async function dashboardPanels(user: SessionUser): Promise<DashboardPanels> {
  const p = await getEffectivePermissions(user.id);
  const has = (k: PermissionKey) => p.has(k);
  const any = (...ks: PermissionKey[]) => ks.some(has);

  const owner = OWNER_NEEDS.every(has);
  // The owner's view already carries the shop's queue, payments and alerts.
  const sales = !owner && any("lead.view_own", "lead.view_team", "target.view_own", "target.view_team");
  const packing = !owner && has("packing.view_queue");
  const accounts = !owner && has("payment.view");
  return {
    owner,
    sales,
    packing,
    accounts,
    counter: !owner && !sales && has("pos.sell") && any("order.view_own", "order.view_team", "order.view_all"),
    can: {
      leads: any("lead.view_own", "lead.view_team", "lead.view_all"),
      targets: any("target.view_own", "target.view_team", "target.view_all"),
      attendanceMark: has("attendance.mark"),
      attendanceBoard: any("attendance.view_team", "attendance.view_all"),
      payments: has("payment.view"),
      wallets: has("wallet.view"),
      expenses: has("expense.view"),
      cod: has("courier.reconcile"),
      inventory: has("inventory.view"),
    },
  };
}
