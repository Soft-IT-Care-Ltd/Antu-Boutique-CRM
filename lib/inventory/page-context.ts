import "server-only";

import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/types";
import type { InventoryNavLink } from "@/lib/inventory/types";
import { LEDGER_VIEW_PERMISSIONS, PURCHASE_VIEW_PERMISSIONS } from "@/lib/inventory/queries";
import { prisma } from "@/lib/prisma";
import { TRANSFER_VIEW_PERMISSIONS } from "@/lib/transfers/constants";

export type InventoryAccess = {
  user: SessionUser;
  hasCostAccess: boolean;
  canAdjust: boolean;
  canViewLedger: boolean;
  canViewPurchases: boolean;
  canViewCatalog: boolean;
  /** C4 — transfers (send / receive / resolve) and stock counts. */
  canViewTransfers: boolean;
  canSendTransfers: boolean;
  canCount: boolean;
  /** C4b — shelves inside a location (only when some location uses them). */
  canUseShelves: boolean;
  navLinks: InventoryNavLink[];
};

/** Every /inventory/* page starts here: the nav-level inventory.view gate, plus what else this user may see. */
export async function getInventoryAccess(): Promise<InventoryAccess> {
  const user = await guardPage("/inventory");
  const [hasCostAccess, canAdjust, canViewLedger, canViewPurchases, canViewCatalog, canViewTransfers, canSendTransfers, canCount, shelfPermission, shelfLocations] = await Promise.all([
    can(user, "product.cost.view"),
    can(user, "inventory.adjust"),
    can(user, LEDGER_VIEW_PERMISSIONS),
    can(user, PURCHASE_VIEW_PERMISSIONS, "all"),
    can(user, "product.view"),
    can(user, TRANSFER_VIEW_PERMISSIONS),
    can(user, "transfer.send"),
    can(user, ["stock.count", "inventory.adjust"]),
    can(user, ["shelf.manage", "shelf.putaway", "stock.count", "inventory.adjust"]),
    prisma.location.count({ where: { usesShelves: true, isActive: true } }),
  ]);
  const canUseShelves = shelfPermission && shelfLocations > 0;

  const navLinks: InventoryNavLink[] = [
    { href: "/inventory", label: "Stock" },
    // C3 (CORRECTIONS.md items 2, 11).
    { href: "/inventory/lookup", label: "Lookup" },
    { href: "/inventory/low-stock", label: "Low stock" },
    { href: "/inventory/negative-stock", label: "Negative stock" },
  ];
  // C4 (CORRECTIONS.md items 2, 3).
  if (canViewTransfers) navLinks.push({ href: "/inventory/transfers", label: "Transfers" });
  if (canSendTransfers) navLinks.push({ href: "/inventory/hub-needs", label: "Needed at hub" });
  if (canUseShelves) navLinks.push({ href: "/inventory/shelves", label: "Shelves" });
  if (canCount) navLinks.push({ href: "/inventory/counts", label: "Stock counts" });
  if (canViewLedger) navLinks.push({ href: "/inventory/movements", label: "Ledger" });
  if (canViewPurchases) {
    navLinks.push({ href: "/inventory/purchases", label: "Purchases" });
    navLinks.push({ href: "/inventory/suppliers", label: "Suppliers" });
  }

  return { user, hasCostAccess, canAdjust, canViewLedger, canViewPurchases, canViewCatalog, canViewTransfers, canSendTransfers, canCount, canUseShelves, navLinks };
}
