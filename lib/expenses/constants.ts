// PRD §4.12 — expenses. Shared by server and client code.

export const EXPENSE_KIND_VALUES = ["AD_COST", "PURCHASE", "COURIER", "SALARY", "RENT", "UTILITY", "PACKAGING", "TRANSPORT", "EXCHANGE_RETURN", "DAMAGE_WRITE_OFF", "STOCK_SHORTAGE", "CASH_OVER_SHORT", "MISC"] as const;
export type ExpenseKindValue = (typeof EXPENSE_KIND_VALUES)[number];

export const EXPENSE_KIND_LABELS: Record<ExpenseKindValue, string> = {
  AD_COST: "Ad cost",
  PURCHASE: "Product purchase",
  COURIER: "Courier",
  SALARY: "Salary",
  RENT: "Rent",
  UTILITY: "Utility",
  PACKAGING: "Packaging",
  TRANSPORT: "Transport",
  EXCHANGE_RETURN: "Exchange / return cost",
  DAMAGE_WRITE_OFF: "Damage / write-off",
  STOCK_SHORTAGE: "Stock shortage",
  CASH_OVER_SHORT: "Cash over/short",
  MISC: "Misc",
};

/**
 * Paying a supplier is cash out, never P&L: stock cost reaches profit as
 * COGS (PRD §4.12 P&L rule). Everything else is an operating expense.
 */
export const NON_OPERATING_EXPENSE_KINDS: ExpenseKindValue[] = ["PURCHASE"];

/** List filter: every heading except supplier payments (P4.3 — what the dashboard's "Expenses" adds up). */
export const OPERATING_EXPENSE_FILTER = "OPERATING";
export const EXPENSE_KIND_FILTER_VALUES = [...EXPENSE_KIND_VALUES, OPERATING_EXPENSE_FILTER] as const;
export type ExpenseKindFilter = (typeof EXPENSE_KIND_FILTER_VALUES)[number];

export const EXPENSE_NATURE_VALUES = ["FIXED", "VARIABLE"] as const;
export type ExpenseNatureValue = (typeof EXPENSE_NATURE_VALUES)[number];

export const EXPENSE_NATURE_LABELS: Record<ExpenseNatureValue, string> = { FIXED: "Fixed", VARIABLE: "Variable" };

export const AD_PLATFORM_VALUES = ["FACEBOOK", "INSTAGRAM", "TIKTOK", "GOOGLE", "OTHER"] as const;
export type AdPlatformValue = (typeof AD_PLATFORM_VALUES)[number];

export const AD_PLATFORM_LABELS: Record<AdPlatformValue, string> = {
  FACEBOOK: "Facebook",
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
  GOOGLE: "Google",
  OTHER: "Other",
};

/** Settings key: how a day's ad spend is spread over that day's confirmed orders. */
export const AD_ALLOCATION_SETTING_KEY = "ad_cost_allocation";
export const AD_ALLOCATION_VALUES = ["EQUAL", "BY_VALUE"] as const;
export type AdAllocationMethod = (typeof AD_ALLOCATION_VALUES)[number];
export const DEFAULT_AD_ALLOCATION: AdAllocationMethod = "EQUAL";

export const AD_ALLOCATION_LABELS: Record<AdAllocationMethod, string> = {
  EQUAL: "Equal split per order",
  BY_VALUE: "By order value",
};

/** The system category every daily ad spend row posts to (seeded, id expcat_ad_cost). */
export const AD_COST_CATEGORY_ID = "expcat_ad_cost";

// Receipts: images are compressed like every other upload; PDFs are kept as-is.
export const EXPENSE_ATTACHMENT_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;

export type ExpenseCategoryOption = {
  id: string;
  name: string;
  kind: ExpenseKindValue;
  defaultNature: ExpenseNatureValue;
  isSystem: boolean;
};
