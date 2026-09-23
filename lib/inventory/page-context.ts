import "server-only";

import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/types";
import type { InventoryNavLink } from "@/lib/inventory/types";
import { LEDGER_VIEW_PERMISSIONS, PURCHASE_VIEW_PERMISSIONS } from "@/lib/inventory/queries";

export type InventoryAccess = {
  user: SessionUser;
  hasCostAccess: boolean;
  canAdjust: boolean;
  canViewLedger: boolean;
  canViewPurchases: boolean;
  canViewCatalog: boolean;
  navLinks: InventoryNavLink[];
};

/** Every /inventory/* page starts here: the nav-level inventory.view gate, plus what else this user may see. */
export async function getInventoryAccess(): Promise<InventoryAccess> {
  const user = await guardPage("/inventory");
  const [hasCostAccess, canAdjust, canViewLedger, canViewPurchases, canViewCatalog] = await Promise.all([
    can(user, "product.cost.view"),
    can(user, "inventory.adjust"),
    can(user, LEDGER_VIEW_PERMISSIONS),
    can(user, PURCHASE_VIEW_PERMISSIONS, "all"),
    can(user, "product.view"),
  ]);

  const navLinks: InventoryNavLink[] = [
    { href: "/inventory", label: "Stock" },
    { href: "/inventory/low-stock", label: "Low stock" },
  ];
  if (canViewLedger) navLinks.push({ href: "/inventory/movements", label: "Ledger" });
  if (canViewPurchases) {
    navLinks.push({ href: "/inventory/purchases", label: "Purchases" });
    navLinks.push({ href: "/inventory/suppliers", label: "Suppliers" });
  }

  return { user, hasCostAccess, canAdjust, canViewLedger, canViewPurchases, canViewCatalog, navLinks };
}
