import type { PaymentMethodValue } from "@/lib/orders/constants";

// PRD §4.7 — POS / showroom sale. Shared by server and client (no server-only).

/** The tenders the counter takes (PRD §4.7: Cash / bKash / Nagad / Card). */
export const POS_PAYMENT_METHODS = ["CASH", "BKASH", "NAGAD", "CARD"] as const satisfies readonly PaymentMethodValue[];
export type PosPaymentMethod = (typeof POS_PAYMENT_METHODS)[number];

/**
 * P3.2 — what a counter payment can be: money, or the customer's store
 * credit (needs their phone number; lib/store-credit/ledger.ts). Store
 * credit moves no money and never touches the drawer.
 */
export const POS_TENDER_METHODS = [...POS_PAYMENT_METHODS, "STORE_CREDIT"] as const satisfies readonly PaymentMethodValue[];
export type PosTenderMethod = (typeof POS_TENDER_METHODS)[number];

/** Bangladeshi notes and coins, largest first — the drawer count helper. */
export const BDT_DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const;
export type Denominations = Partial<Record<`${(typeof BDT_DENOMINATIONS)[number]}`, number>>;

export function denominationTotal(counts: Denominations): number {
  return BDT_DENOMINATIONS.reduce((sum, d) => sum + d * (counts[`${d}`] ?? 0), 0);
}

/**
 * Settings key: which wallet is the showroom cash drawer. Defaults to the
 * "Showroom Cash" wallet the P2.3 migration created.
 */
export const POS_CASH_WALLET_SETTING_KEY = "pos_cash_wallet_id";
export const DEFAULT_POS_CASH_WALLET_ID = "wallet_showroom_cash";

/** The system category a drawer's day-end difference posts to (migration 20260925090100). */
export const CASH_OVER_SHORT_CATEGORY_ID = "expcat_cash_over_short";

/** What a cash movement recorded at the drawer does to the wallet. */
export const DRAWER_MOVEMENT_KINDS = ["DEPOSIT", "EXPENSE", "CASH_OUT", "CASH_IN"] as const;
export type DrawerMovementKind = (typeof DRAWER_MOVEMENT_KINDS)[number];

export const DRAWER_MOVEMENT_LABELS: Record<DrawerMovementKind, string> = {
  DEPOSIT: "Deposit / hand over to another wallet",
  EXPENSE: "Pay an expense from the drawer",
  CASH_OUT: "Other cash out",
  CASH_IN: "Cash added (change, top-up)",
};
