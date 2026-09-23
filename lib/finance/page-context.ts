import "server-only";

import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/types";

// Every /payments/* and /expenses/* page starts here: the nav-level gate
// (guardPage checks the module's own permission), plus what else this user
// may do. Sub-pages aren't in the nav map, so they must come through here.

export type SectionLink = { href: string; label: string };

export type PaymentsAccess = {
  user: SessionUser;
  canVerify: boolean;
  canRefund: boolean;
  canDecideRefund: boolean;
  canViewWallets: boolean;
  canWalletEntry: boolean;
  canManageWallets: boolean;
  links: SectionLink[];
};

export async function getPaymentsAccess(): Promise<PaymentsAccess> {
  const user = await guardPage("/payments");
  const [canVerify, canRefund, canDecideRefund, canViewWallets, canWalletEntry, canManageWallets] = await Promise.all([
    can(user, "payment.verify"),
    can(user, "payment.refund"),
    can(user, "payment.refund_approve"),
    can(user, "wallet.view"),
    can(user, "wallet.entry"),
    can(user, "wallet.manage"),
  ]);
  const links: SectionLink[] = [
    { href: "/payments", label: "Verification" },
    { href: "/payments/refunds", label: "Refunds" },
    { href: "/payments/history", label: "All payments" },
  ];
  if (canViewWallets) links.push({ href: "/payments/wallets", label: "Wallets" });
  links.push({ href: "/payments/collection", label: "Collection report" });
  return { user, canVerify, canRefund, canDecideRefund, canViewWallets, canWalletEntry: canViewWallets && canWalletEntry, canManageWallets: canViewWallets && canManageWallets, links };
}

export type ExpensesAccess = {
  user: SessionUser;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canSetAllocation: boolean;
  links: SectionLink[];
};

export async function getExpensesAccess(): Promise<ExpensesAccess> {
  const user = await guardPage("/expenses");
  const [canCreate, canEdit, canDelete, canSetAllocation] = await Promise.all([
    can(user, "expense.create"),
    can(user, "expense.edit"),
    can(user, "expense.delete"),
    can(user, "settings.manage"),
  ]);
  return {
    user,
    canCreate,
    canEdit,
    canDelete,
    canSetAllocation,
    links: [
      { href: "/expenses", label: "Expenses" },
      { href: "/expenses/ad-spend", label: "Ad spend" },
      { href: "/expenses/report", label: "Expense report" },
    ],
  };
}
