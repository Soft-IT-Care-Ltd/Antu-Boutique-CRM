import type { PaymentMethodValue } from "@/lib/orders/constants";

// PRD §4.10 — wallets. Shared by server and client code (no server-only).

export const WALLET_TYPE_VALUES = ["BKASH", "NAGAD", "ROCKET", "BANK", "CASH"] as const;
export type WalletTypeValue = (typeof WALLET_TYPE_VALUES)[number];

export const WALLET_TYPE_LABELS: Record<WalletTypeValue, string> = {
  BKASH: "bKash",
  NAGAD: "Nagad",
  ROCKET: "Rocket",
  BANK: "Bank",
  CASH: "Cash",
};

/**
 * Which wallets a payment method can land in. A bKash payment can't go into
 * Showroom Cash; a card payment settles to the bank. COURIER_COD has none —
 * that money reaches a wallet as the courier statement's net payout.
 */
export const METHOD_WALLET_TYPES: Record<PaymentMethodValue, readonly WalletTypeValue[]> = {
  BKASH: ["BKASH"],
  NAGAD: ["NAGAD"],
  ROCKET: ["ROCKET"],
  BANK: ["BANK"],
  CARD: ["BANK"],
  CASH: ["CASH"],
  COURIER_COD: [],
  EXCHANGE_CREDIT: [],
  STORE_CREDIT: [],
};

export const WALLET_ENTRY_TYPE_VALUES = ["MANUAL_IN", "MANUAL_OUT", "TRANSFER_IN", "TRANSFER_OUT"] as const;
export type WalletEntryTypeValue = (typeof WALLET_ENTRY_TYPE_VALUES)[number];

export const WALLET_ENTRY_TYPE_LABELS: Record<WalletEntryTypeValue, string> = {
  MANUAL_IN: "Money in",
  MANUAL_OUT: "Money out",
  TRANSFER_IN: "Transfer in",
  TRANSFER_OUT: "Transfer out",
};

/** What a wallet statement row came from. */
export const WALLET_FLOW_SOURCES = ["PAYMENT", "REFUND", "EXPENSE", "ENTRY", "COURIER_PAYOUT"] as const;
export type WalletFlowSource = (typeof WALLET_FLOW_SOURCES)[number];

export const WALLET_FLOW_SOURCE_LABELS: Record<WalletFlowSource, string> = {
  PAYMENT: "Payment",
  REFUND: "Refund",
  EXPENSE: "Expense",
  ENTRY: "Manual entry",
  COURIER_PAYOUT: "Courier payout",
};

export type WalletOption = { id: string; name: string; type: WalletTypeValue };

/** Wallets a payment made by `method` may be recorded into, active ones only. */
export function walletsForMethod<T extends { type: WalletTypeValue }>(wallets: T[], method: PaymentMethodValue): T[] {
  const types = METHOD_WALLET_TYPES[method];
  return wallets.filter((w) => types.includes(w.type));
}
