import type { LucideIcon } from "lucide-react";
import {
  Banknote,
  BarChart3,
  Boxes,
  CalendarCheck,
  LayoutDashboard,
  PackageCheck,
  Receipt,
  Repeat2,
  ScrollText,
  Settings,
  Shirt,
  ShoppingBag,
  Store,
  Tags,
  Trash2,
  Trophy,
  Truck,
  UserRound,
  Users2,
  Wallet,
} from "lucide-react";

import type { PermissionKey } from "@/lib/auth/permission-definitions";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Item is hidden unless the signed-in user holds at least one of these. Omit to always show (e.g. Dashboard). */
  permission?: PermissionKey | PermissionKey[];
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};

// One placeholder route per module in PRD §4. Business logic lands module by
// module starting Phase 1 — for now every route renders a shared placeholder.
// `permission` gates sidebar visibility (see lib/auth/permissions.ts) — the
// route itself must still enforce access independently; the nav is a
// convenience, not the security boundary.
export const navGroups: NavGroup[] = [
  {
    label: "Overview",
    items: [{ label: "Dashboard", href: "/dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Sales",
    items: [
      { label: "Leads", href: "/leads", icon: Users2, permission: ["lead.view_own", "lead.view_team", "lead.view_all"] },
      {
        label: "Customers",
        href: "/customers",
        icon: UserRound,
        permission: ["customer.view_own", "customer.view_team", "customer.view_all"],
      },
      { label: "Orders", href: "/orders", icon: ShoppingBag, permission: ["order.view_own", "order.view_team", "order.view_all"] },
      { label: "POS", href: "/pos", icon: Store, permission: "pos.sell" },
      // Accounts reviews past days' counts (wallet.view) without selling.
      { label: "Cash drawer", href: "/pos/drawer", icon: Banknote, permission: ["pos.drawer", "wallet.view"] },
    ],
  },
  {
    label: "Catalog & Stock",
    items: [
      { label: "Catalog", href: "/catalog", icon: Shirt, permission: "product.view" },
      { label: "Price tags", href: "/catalog/price-tags", icon: Tags, permission: "product.tags.print" },
      { label: "Inventory", href: "/inventory", icon: Boxes, permission: "inventory.view" },
    ],
  },
  {
    label: "Fulfilment",
    items: [
      { label: "Packing", href: "/packing", icon: PackageCheck, permission: "packing.view_queue" },
      { label: "Courier", href: "/courier", icon: Truck, permission: ["courier.view", "courier.create_shipment", "courier.reconcile", "courier.manage", "courier.return_check"] },
    ],
  },
  {
    label: "Money",
    items: [
      { label: "Payments & Wallets", href: "/payments", icon: Wallet, permission: "payment.view" },
      { label: "Expenses", href: "/expenses", icon: Receipt, permission: "expense.view" },
    ],
  },
  {
    label: "Returns",
    items: [
      {
        label: "Returns & Exchanges",
        href: "/returns-exchanges",
        icon: Repeat2,
        permission: ["return.view", "exchange.view"],
      },
    ],
  },
  {
    label: "Performance",
    items: [
      {
        label: "Targets & Leaderboard",
        href: "/targets",
        icon: Trophy,
        permission: ["target.view_own", "target.view_team", "target.view_all"],
      },
      {
        label: "Attendance",
        href: "/attendance",
        icon: CalendarCheck,
        permission: ["attendance.view_own", "attendance.view_team", "attendance.view_all"],
      },
      { label: "Reports", href: "/reports", icon: BarChart3, permission: "report.view" },
    ],
  },
  {
    label: "System",
    items: [
      { label: "Settings", href: "/settings", icon: Settings, permission: "settings.manage" },
      { label: "Audit log", href: "/audit-log", icon: ScrollText, permission: "audit.view" },
      // PRD §4.18 — whoever can delete a kind of record can restore it.
      { label: "Trash", href: "/trash", icon: Trash2, permission: ["order.delete", "customer.delete", "product.delete", "lead.delete"] },
    ],
  },
];

export const allNavItems: NavItem[] = navGroups.flatMap((group) => group.items);

/** The permission a route requires, per its nav entry — the single source both the sidebar and page guards read from. */
export function getRequiredPermission(href: string): PermissionKey | PermissionKey[] | undefined {
  return allNavItems.find((item) => item.href === href)?.permission;
}

/** Filters navGroups down to items the given permission set can see, dropping any group left empty. */
export function filterNavGroups(groups: NavGroup[], permissions: ReadonlySet<PermissionKey>): NavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        if (!item.permission) return true;
        const required = Array.isArray(item.permission) ? item.permission : [item.permission];
        return required.some((key) => permissions.has(key));
      }),
    }))
    .filter((group) => group.items.length > 0);
}
