// Client-safe inventory constants (labels, enums as plain arrays) — no DB.

export const STOCK_MOVEMENT_TYPES = [
  "PURCHASE_IN",
  "SALE_OUT",
  "RETURN_IN",
  "EXCHANGE_OUT",
  "EXCHANGE_IN",
  "DAMAGE_OUT",
  "ADJUSTMENT",
  "POS_SALE_OUT",
  "PACKAGING_OUT",
] as const;
export type StockMovementTypeValue = (typeof STOCK_MOVEMENT_TYPES)[number];

export const STOCK_MOVEMENT_LABELS: Record<StockMovementTypeValue, string> = {
  PURCHASE_IN: "Purchase in",
  SALE_OUT: "Sale out",
  RETURN_IN: "Return in",
  EXCHANGE_OUT: "Exchange out",
  EXCHANGE_IN: "Exchange in",
  DAMAGE_OUT: "Damage / write-off",
  ADJUSTMENT: "Adjustment",
  POS_SALE_OUT: "POS sale out",
  PACKAGING_OUT: "Packaging used",
};

export const STOCK_REFERENCE_LABELS: Record<string, string> = {
  OPENING_BALANCE: "Opening balance",
  PURCHASE: "Purchase",
  ORDER: "Order",
  ADJUSTMENT: "Manual adjustment",
  DAMAGE: "Write-off",
  RETURN: "Return",
  EXCHANGE: "Exchange",
};

export const ALLOCATION_METHOD_LABELS = {
  BY_VALUE: "By line value",
  BY_QTY: "By quantity",
} as const;

/**
 * The system expense category a DAMAGE_OUT write-off posts to — its own
 * DAMAGE_WRITE_OFF heading, never Misc, so monthly damage losses show on
 * their own (seeded by the P2.1 migration, renamed in 20260924090100).
 */
export const WRITE_OFF_EXPENSE_CATEGORY_ID = "expcat_stock_writeoff";
export const WRITE_OFF_EXPENSE_CATEGORY = "Damage / write-off";

/**
 * The system expense category every manual stock adjustment posts to at
 * cost — a shortfall as a cost, stock found as a credit — so it shows the
 * net unexplained loss, apart from damage (migration 20260924140100).
 */
export const SHORTAGE_EXPENSE_CATEGORY_ID = "expcat_stock_shortage";
export const SHORTAGE_EXPENSE_CATEGORY = "Stock shortage";

export const STOCK_STATUS_FILTERS = ["all", "in", "low", "out"] as const;
export type StockStatusFilter = (typeof STOCK_STATUS_FILTERS)[number];

export type VariantStockStatus = "OK" | "LOW" | "OUT";

/** Per-variant status from available (= on hand − reserved) against its low-stock threshold. */
export function variantStockStatus(available: number, threshold: number): VariantStockStatus {
  if (available <= 0) return "OUT";
  if (available <= threshold) return "LOW";
  return "OK";
}

// CLAUDE.md: store UTC, display Asia/Dhaka.
const DHAKA_DATE = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "2-digit", month: "short", year: "numeric" });
const DHAKA_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Dhaka",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export const formatDhakaDate = (iso: string | Date) => DHAKA_DATE.format(new Date(iso));
export const formatDhakaDateTime = (iso: string | Date) => DHAKA_DATE_TIME.format(new Date(iso));

/** Today's calendar date in Dhaka as YYYY-MM-DD (for <input type="date"> defaults). */
export const todayInDhaka = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date());

/** Midnight at the start of a Dhaka calendar day (YYYY-MM-DD), as a UTC instant; offsetDays shifts it (1 = next day's start, for an exclusive upper bound). */
export function dhakaDayStartUtc(day: string, offsetDays = 0): Date {
  const date = new Date(`${day}T00:00:00+06:00`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date;
}
