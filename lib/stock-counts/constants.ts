// C4 (CORRECTIONS.md item 2) — client-safe stock-count labels and shapes.

export const STOCK_COUNT_STATUSES = ["OPEN", "POSTED", "CANCELLED"] as const;
export type StockCountStatusValue = (typeof STOCK_COUNT_STATUSES)[number];

export const STOCK_COUNT_STATUS_LABELS: Record<StockCountStatusValue, string> = {
  OPEN: "Counting",
  POSTED: "Posted",
  CANCELLED: "Cancelled",
};

export const STOCK_COUNT_SCOPES = ["SPOT", "FULL"] as const;
export type StockCountScopeValue = (typeof STOCK_COUNT_SCOPES)[number];

export const STOCK_COUNT_SCOPE_LABELS: Record<StockCountScopeValue, { label: string; hint: string }> = {
  SPOT: { label: "Spot count", hint: "A shelf or a rack — only what you scan is compared." },
  FULL: { label: "Full count", hint: "The whole location — anything not scanned counts as none and is taken off." },
};

/** One variant on a count. Never carries cost. */
export type StockCountLineView = {
  variantId: string;
  sku: string;
  productName: string;
  sizeName: string;
  colorName: string;
  colorHex: string;
  thumbPath: string | null;
  scanned: boolean;
  counted: number;
  /** The location's stock: live while counting, frozen at posting. */
  expected: number;
  /** counted − expected: + extra found, − short. */
  difference: number;
};

export type StockCountView = {
  id: string;
  countNo: string;
  status: StockCountStatusValue;
  scope: StockCountScopeValue;
  location: { id: string; name: string };
  note: string | null;
  createdByName: string | null;
  createdAt: string;
  postedByName: string | null;
  postedAt: string | null;
  lines: StockCountLineView[];
  totals: { counted: number; expected: number; short: number; extra: number; itemsWithDifference: number };
  can: { scan: boolean; post: boolean; cancel: boolean };
};

export type StockCountListItem = {
  id: string;
  countNo: string;
  status: StockCountStatusValue;
  scope: StockCountScopeValue;
  locationName: string;
  items: number;
  units: number;
  differences: number | null;
  createdByName: string | null;
  createdAt: string;
  postedAt: string | null;
};
