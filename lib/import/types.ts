// P5.2 opening-data import — what a preview or a commit reports back.
// Client- and server-safe.

export const IMPORT_KINDS = ["products", "customers", "wallets"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** `line` is the row number as the sheet shows it (the header is row 1); null = about the whole file. */
export type ImportIssue = { line: number | null; message: string };

export type ImportSummaryItem = { label: string; value: string };

export type ImportReport = {
  kind: ImportKind;
  rows: number;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  /** A few headline numbers ("New products: 12"). */
  summary: ImportSummaryItem[];
  /** What will happen / happened, one line per record, capped for display. */
  preview: { line: number; text: string }[];
  committed: boolean;
};

export class ImportFailed extends Error {
  constructor(readonly report: ImportReport) {
    super(`${report.errors.length} row${report.errors.length === 1 ? "" : "s"} need fixing`);
  }
}

export type ColumnDoc = { name: string; required?: boolean; note: string };

/** What each sheet's columns mean — shown on the import screen and used to write the template. */
export const IMPORT_COLUMNS: Record<ImportKind, ColumnDoc[]> = {
  products: [
    { name: "product_code", note: "2–3 capital letters/digits (K12). Blank: suggested from the name. Rows with the same code are one product." },
    { name: "product_name", required: true, note: "Rows with the same name (and no code) are one product." },
    { name: "type", note: "sale (default) or packaging." },
    { name: "category", note: "A category from Settings → Catalog masters." },
    { name: "brand", note: "" },
    { name: "fabric", note: "" },
    { name: "description", note: "" },
    { name: "base_price", note: "Selling price (৳). Required for a new product for sale; blank for packaging." },
    { name: "tags", note: "Separate with ; (eyelet; eid)." },
    { name: "size", required: true, note: "A size name or code from Settings (M, XL, Free)." },
    { name: "colour", required: true, note: "A colour name or code from Settings (Maroon or MRN)." },
    { name: "sku", note: "Blank: product code + size code + colour code. At most 9 capital letters/digits." },
    { name: "price_override", note: "This size/colour's price if it differs from base_price." },
    { name: "opening_qty", note: "Units on the shelf on the opening day. Posted as an opening balance in the stock ledger." },
    { name: "unit_cost", note: "Cost per unit (৳) — required with opening_qty. Becomes the variant's average cost." },
    { name: "location", note: "Where the opening stock sits (a location name from Settings → Locations). Blank = the packing hub. Repeat a size/colour on another row to put stock at a second location." },
    { name: "low_stock_threshold", note: "Blank: the Settings default." },
    { name: "weight_grams", note: "Per unit, for courier cost estimates." },
  ],
  customers: [
    { name: "name", required: true, note: "" },
    { name: "phone", required: true, note: "Bangladeshi mobile (017…, +88017…). Already in the system: skipped." },
    { name: "alt_phone", note: "Optional second number." },
    { name: "division", note: "One of the 8 divisions (Dhaka, Chattogram, …)." },
    { name: "district", note: "" },
    { name: "thana", note: "" },
    { name: "address", note: "House, road, area." },
    { name: "notes", note: "" },
    { name: "tags", note: "VIP; Wholesale; Problem customer — separate with ;" },
    { name: "owner_phone", note: "The staff member who looks after them (their login phone). Blank: you. Sales Executives only see their own customers." },
  ],
  wallets: [
    { name: "wallet_name", required: true, note: "An existing wallet's name updates it; a new name adds a wallet." },
    { name: "type", required: true, note: "bKash, Nagad, Rocket, Bank or Cash." },
    { name: "account_no", note: "" },
    { name: "opening_balance", required: true, note: "What the wallet held when counted (৳). Can be negative (an overdrawn bank)." },
    { name: "opening_date", required: true, note: "The day it was counted: YYYY-MM-DD or DD/MM/YYYY. Money dated before it is inside the balance." },
    { name: "note", note: "" },
  ],
};

/** Two example rows per sheet for the downloadable template. */
export const IMPORT_EXAMPLES: Record<ImportKind, string[][]> = {
  products: [
    ["K12", "Embroidered Kurti 12", "sale", "Kurti", "Antu House", "Cotton", "", "1850", "eid; new", "M", "Maroon", "", "", "6", "950", "", "350"],
    ["K12", "Embroidered Kurti 12", "sale", "Kurti", "Antu House", "Cotton", "", "1850", "eid; new", "L", "Maroon", "", "1950", "4", "950", "2", "380"],
  ],
  customers: [
    ["ফারজানা আক্তার", "01911223344", "", "Dhaka", "Dhaka", "Mirpur", "House 12, Road 5, Mirpur 10", "Prefers bKash", "VIP", ""],
    ["Rezaul Karim", "+8801812345678", "01912345678", "Dhaka", "Dhaka", "Dhanmondi", "Road 27", "", "Wholesale", ""],
  ],
  wallets: [
    ["bKash Personal", "bKash", "01711000001", "42500", "2026-10-01", ""],
    ["Showroom Cash", "Cash", "", "8000", "01/10/2026", "Counted at closing"],
  ],
};
