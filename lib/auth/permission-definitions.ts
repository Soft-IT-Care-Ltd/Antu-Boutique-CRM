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
  { key: "customer.credit.adjust", group: "Customers", label: "Adjust a customer's store credit (with a reason)" },

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
    key: "order.courier_status_override",
    group: "Orders",
    label: "Move a courier-booked order by hand (with a reason)",
  },
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
  { key: "product.tags.print", group: "Catalog", label: "Print price tags" },

  // Inventory
  { key: "inventory.view", group: "Inventory", label: "View stock on hand" },
  { key: "inventory.purchase.create", group: "Inventory", label: "Record purchases" },
  { key: "inventory.adjust", group: "Inventory", label: "Manual stock adjustment" },
  // C3 (CORRECTIONS.md item 2): without it, stock actions are limited to
  // the locations the person is assigned to (Settings → Users).
  { key: "location.all", group: "Inventory", label: "Act for every stock location (not only assigned ones)" },
  // C4 (CORRECTIONS.md items 2, 3): scan screens for the location
  // incharges. Each acts only at the person's own locations (location.all:
  // every one) — send from the source, receive at the destination.
  { key: "transfer.send", group: "Inventory", label: "Send stock transfers (scan out) from own locations" },
  { key: "transfer.receive", group: "Inventory", label: "Receive stock transfers (scan in) at own locations" },
  { key: "transfer.resolve", group: "Inventory", label: "Resolve units missing in transit (found / write off)" },
  { key: "stock.count", group: "Inventory", label: "Count stock by scan at own locations (posting needs Manual stock adjustment)" },

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
  { key: "payment.refund", group: "Payments", label: "Request refunds" },
  { key: "payment.refund_approve", group: "Payments", label: "Approve or reject refunds" },

  // Wallets (P2.3)
  { key: "wallet.view", group: "Wallets", label: "View wallet balances & statements" },
  { key: "wallet.entry", group: "Wallets", label: "Record manual wallet entries & transfers" },
  { key: "wallet.manage", group: "Wallets", label: "Add wallets & set opening balances" },

  // Expenses
  { key: "expense.view", group: "Expenses", label: "View expenses" },
  { key: "expense.create", group: "Expenses", label: "Record expenses" },
  { key: "expense.edit", group: "Expenses", label: "Edit expenses" },
  { key: "expense.delete", group: "Expenses", label: "Delete expenses" },

  // POS
  { key: "pos.sell", group: "POS", label: "Take POS sales" },
  { key: "pos.drawer", group: "POS", label: "Open and close the cash drawer, record cash in/out" },

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
  { key: "leave.approve", group: "Attendance", label: "Approve or reject leave requests (never one's own)" },

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

  // order.courier_status_override is Admin-only: it overrides what the
  // courier reports (API down, parcel lost) and must stay rare.
  // customer.credit.adjust is Admin-only too (PRD §4.11): a store credit
  // balance changes by hand only with a reason, and only by the owner.
  MANAGER: withoutKeys(["settings.manage", "user.delete", "permission.manage", "audit.view", "order.courier_status_override", "customer.credit.adjust"]),

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
    // P3.2: a TL requests returns/exchanges for the team and approves the
    // ones their executives ask for (never their own — lib/returns/cases.ts).
    "return.view",
    "return.create",
    "return.approve",
    "exchange.view",
    "exchange.create",
    "exchange.approve",
    "target.view_team",
    "attendance.view_team",
    "attendance.view_own",
    "attendance.mark",
    // P4.2 (PRD §4.14): a TL decides their team's leave requests.
    "leave.approve",
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
    // P3.2: the executive talks to the customer, so asks for the return or
    // exchange on their own orders; a TL/Manager/Admin approves it.
    "return.view",
    "return.create",
    "exchange.view",
    "exchange.create",
    "target.view_own",
    "attendance.view_own",
    "attendance.mark",
    // P4.4 (PRD §4.15): "an SE's report shows only their own data" — the
    // reports they can run follow their module permissions and every one
    // is scoped to their own records (lib/reports/access.ts). No export.
    "report.view",
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
    // C4: the hub's incharge sends to and receives from other locations,
    // and counts the warehouse (a Manager posts the count's difference).
    "transfer.send",
    "transfer.receive",
    "stock.count",
    "courier.create_shipment",
    "courier.return_check",
    "attendance.view_own",
    "attendance.mark",
  ],

  // Refunds are requested by Accounts and approved by a Manager/Admin —
  // payment.refund_approve is deliberately absent here.
  ACCOUNTS: [
    "payment.view",
    "payment.create",
    "payment.edit",
    "payment.verify",
    "payment.refund",
    "wallet.view",
    "wallet.entry",
    "expense.view",
    "expense.create",
    "expense.edit",
    "courier.reconcile",
    "order.view_all",
    // P3.2: sees returns/exchanges to pay out the refunds they leave owed.
    "return.view",
    "exchange.view",
    "report.view",
    "attendance.view_own",
    "attendance.mark",
  ],

  // pos.drawer lets the operator record cash leaving the drawer (a deposit,
  // a petty expense) — only from the drawer's own wallet, only for today
  // (lib/pos/drawer.ts) — without the general wallet.entry/expense.create.
  POS_OPERATOR: [
    "pos.sell",
    "pos.drawer",
    // P3.2: exchanges at the counter — no approval, settled on the spot.
    "exchange.view",
    "exchange.create",
    "product.tags.print",
    "customer.view_own",
    "customer.create",
    "order.view_own",
    "order.create",
    "product.view",
    "inventory.view",
    // C4: the showroom incharge sends dresses to the packing hub, receives
    // transfers and counts the showroom.
    "transfer.send",
    "transfer.receive",
    "stock.count",
    "attendance.view_own",
    "attendance.mark",
  ],
};
