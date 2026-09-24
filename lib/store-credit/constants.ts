// P3.2 — store credit (PRD §4.11, §4.12). Shared by server and client.

export const STORE_CREDIT_ENTRY_TYPES = ["ISSUED", "USED", "RESTORED", "ADJUSTED"] as const;
export type StoreCreditEntryTypeValue = (typeof STORE_CREDIT_ENTRY_TYPES)[number];

export const STORE_CREDIT_ENTRY_LABELS: Record<StoreCreditEntryTypeValue, string> = {
  ISSUED: "Issued",
  USED: "Used",
  RESTORED: "Given back",
  ADJUSTED: "Adjusted",
};

export const RETURN_SETTLEMENT_VALUES = ["REFUND", "STORE_CREDIT"] as const;
export type ReturnSettlementValue = (typeof RETURN_SETTLEMENT_VALUES)[number];

export const RETURN_SETTLEMENT_LABELS: Record<ReturnSettlementValue, string> = {
  REFUND: "Refund (needs approval)",
  STORE_CREDIT: "Store credit",
};

/**
 * Settings key: days until newly added credit lapses. Absent or empty =
 * credit never expires (the default). Changing it affects credit added from
 * then on; what was already issued keeps the expiry it was given.
 */
export const STORE_CREDIT_EXPIRY_SETTING_KEY = "store_credit_expiry_days";
export const MAX_STORE_CREDIT_EXPIRY_DAYS = 3650;
