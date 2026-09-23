import type { RoleName } from "@prisma/client";

// The single source of truth for every permission string in the system.
// prisma/seed.ts writes these rows into `permissions` and `role_permissions`;
// lib/auth/permissions.ts reads the DB (not this file) at request time, so
// that Settings can edit role→permission mappings later without a code
// change. This file only defines what's *possible* and the starting
// template each role seeds with.

export const PERMISSIONS = [
  // Users & system
  { key: "user.view", group: "Users", label: "View staff accounts" },
  { key: "user.create", group: "Users", label: "Create staff accounts" },
  { key: "user.edit", group: "Users", label: "Edit staff accounts" },
  { key: "user.delete", group: "Users", label: "Deactivate/delete staff accounts" },
  { key: "permission.manage", group: "Users", label: "Edit roles and permission overrides" },
  { key: "settings.manage", group: "System", label: "Edit business settings" },
  { key: "audit.view", group: "System", label: "View audit log" },

  // Leads
  { key: "lead.view_own", group: "Leads", label: "View own leads" },
  { key: "lead.view_team", group: "Leads", label: "View team leads" },
  { key: "lead.view_all", group: "Leads", label: "View all leads" },
  { key: "lead.create", group: "Leads", label: "Create leads" },
  { key: "lead.edit", group: "Leads", label: "Edit leads" },
  { key: "lead.delete", group: "Leads", label: "Delete leads" },
  { key: "lead.convert", group: "Leads", label: "Convert lead to order" },

  // Customers
  { key: "customer.view_own", group: "Customers", label: "View own customers" },
  { key: "customer.view_team", group: "Customers", label: "View team customers" },
  { key: "customer.view_all", group: "Customers", label: "View all customers" },
  { key: "customer.create", group: "Customers", label: "Create customers" },
  { key: "customer.edit", group: "Customers", label: "Edit customers" },
  { key: "customer.delete", group: "Customers", label: "Delete customers" },

  // Orders
  { key: "order.view_own", group: "Orders", label: "View own orders" },
  { key: "order.view_team", group: "Orders", label: "View team orders" },
  { key: "order.view_all", group: "Orders", label: "View all orders" },
  { key: "order.create", group: "Orders", label: "Create orders" },
  { key: "order.edit", group: "Orders", label: "Edit orders" },
  { key: "order.edit_after_window", group: "Orders", label: "Edit orders after the edit window" },
  { key: "order.cancel", group: "Orders", label: "Cancel orders" },
  { key: "order.delete", group: "Orders", label: "Delete orders" },
  { key: "order.status_update", group: "Orders", label: "Update order status" },
  {
    key: "order.stock_override",
    group: "Orders",
    label: "Sell below available stock with a reason",
  },

  // Catalog
  { key: "product.view", group: "Catalog", label: "View products & variants" },
  { key: "product.create", group: "Catalog", label: "Create products & variants" },
  { key: "product.edit", group: "Catalog", label: "Edit products & variants" },
  { key: "product.delete", group: "Catalog", label: "Delete products & variants" },
  { key: "product.cost.view", group: "Catalog", label: "View cost, profit, margin & purchase price" },
  { key: "catalog.manage", group: "Catalog", label: "Manage categories, sizes & colours" },

  // Inventory
  { key: "inventory.view", group: "Inventory", label: "View stock on hand" },
  { key: "inventory.purchase.create", group: "Inventory", label: "Record purchases" },
  { key: "inventory.adjust", group: "Inventory", label: "Manual stock adjustment" },

  // Packing
  { key: "packing.view_queue", group: "Packing", label: "View packing queue" },
  { key: "packing.pack", group: "Packing", label: "Pack orders" },

  // Courier
  { key: "courier.view", group: "Courier", label: "View shipments" },
  { key: "courier.create_shipment", group: "Courier", label: "Hand over to courier" },
  { key: "courier.reconcile", group: "Courier", label: "Reconcile courier statements" },
  { key: "courier.manage", group: "Courier", label: "Manage courier integration, cost rates & sync" },
  { key: "courier.return_check", group: "Courier", label: "Condition-check returned parcels" },

  // Payments
  { key: "payment.view", group: "Payments", label: "View payments & wallets" },
  { key: "payment.create", group: "Payments", label: "Record payments" },
  { key: "payment.edit", group: "Payments", label: "Edit payments" },
  { key: "payment.delete", group: "Payments", label: "Delete payments" },
  { key: "payment.verify", group: "Payments", label: "Verify payments" },

  // Expenses
  { key: "expense.view", group: "Expenses", label: "View expenses" },
  { key: "expense.create", group: "Expenses", label: "Record expenses" },
  { key: "expense.edit", group: "Expenses", label: "Edit expenses" },
  { key: "expense.delete", group: "Expenses", label: "Delete expenses" },

  // POS
  { key: "pos.sell", group: "POS", label: "Take POS sales" },

  // Returns & exchanges
  { key: "return.view", group: "Returns", label: "View returns" },
  { key: "return.create", group: "Returns", label: "Create returns" },
  { key: "return.approve", group: "Returns", label: "Approve returns" },
  { key: "exchange.view", group: "Returns", label: "View exchanges" },
  { key: "exchange.create", group: "Returns", label: "Create exchanges" },
  { key: "exchange.approve", group: "Returns", label: "Approve exchanges" },

  // Targets
  { key: "target.view_own", group: "Targets", label: "View own targets" },
  { key: "target.view_team", group: "Targets", label: "View team targets" },
  { key: "target.view_all", group: "Targets", label: "View all targets" },
  { key: "target.manage", group: "Targets", label: "Set targets & reward rules" },

  // Attendance
  { key: "attendance.view_own", group: "Attendance", label: "View own attendance" },
  { key: "attendance.view_team", group: "Attendance", label: "View team attendance" },
  { key: "attendance.view_all", group: "Attendance", label: "View all attendance" },
  { key: "attendance.mark", group: "Attendance", label: "Mark attendance" },
  { key: "attendance.manage", group: "Attendance", label: "Manage attendance & leave" },

  // Reports
  { key: "report.view", group: "Reports", label: "View reports" },
  { key: "report.pl.view", group: "Reports", label: "View profit & loss" },
  { key: "report.export", group: "Reports", label: "Export reports" },
] as const satisfies ReadonlyArray<{ key: string; group: string; label: string }>;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

const ALL_KEYS: PermissionKey[] = PERMISSIONS.map((p) => p.key);

const withoutKeys = (exclude: PermissionKey[]): PermissionKey[] =>
  ALL_KEYS.filter((key) => !exclude.includes(key));

// Starting permission set each role is seeded with. Editable later from
// Settings (per PRD §4.17) — this array only feeds prisma/seed.ts.
export const ROLE_TEMPLATES: Record<RoleName, PermissionKey[]> = {
  ADMIN: ALL_KEYS,

  MANAGER: withoutKeys(["settings.manage", "user.delete", "permission.manage", "audit.view"]),

  TEAM_LEADER: [
    "lead.view_team",
    "lead.create",
    "lead.edit",
    "lead.convert",
    "customer.view_team",
    "customer.create",
    "customer.edit",
    "order.view_team",
    "order.create",
    "order.edit",
    "order.edit_after_window",
    "order.status_update",
    "product.view",
    "inventory.view",
    "return.view",
    "return.approve",
    "exchange.view",
    "exchange.approve",
    "target.view_team",
    "attendance.view_team",
    "attendance.view_own",
    "attendance.mark",
    "report.view",
  ],

  SALES_EXECUTIVE: [
    "lead.view_own",
    "lead.create",
    "lead.edit",
    "lead.convert",
    "customer.view_own",
    "customer.create",
    "customer.edit",
    "order.view_own",
    "order.create",
    "order.edit",
    "product.view",
    "inventory.view",
    "target.view_own",
    "attendance.view_own",
    "attendance.mark",
  ],

  // PRD §4.8: "must not see customer money data beyond what is printed on
  // the packing slip" — deliberately WITHOUT order.view_own/team/all. Those
  // permissions gate the generic Orders screen and its totals/payments
  // panel, so granting one would let Packing browse full order money
  // through a side door. Packing sees orders only through its own
  // money-free queue/detail routes (lib/packing/*); order.view_all
  // reference-image visibility is covered separately by
  // lib/orders/access.ts's canViewOrder checking packing.view_queue.
  PACKING: [
    "packing.view_queue",
    "packing.pack",
    "order.status_update",
    "inventory.view",
    "courier.create_shipment",
    "courier.return_check",
    "attendance.view_own",
    "attendance.mark",
  ],

  ACCOUNTS: [
    "payment.view",
    "payment.create",
    "payment.edit",
    "payment.verify",
    "expense.view",
    "expense.create",
    "expense.edit",
    "courier.reconcile",
    "order.view_all",
    "report.view",
    "attendance.view_own",
    "attendance.mark",
  ],

  POS_OPERATOR: [
    "pos.sell",
    "customer.view_own",
    "customer.create",
    "order.view_own",
    "order.create",
    "product.view",
    "inventory.view",
    "attendance.view_own",
    "attendance.mark",
  ],
};
