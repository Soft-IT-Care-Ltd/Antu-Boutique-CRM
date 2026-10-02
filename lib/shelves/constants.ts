// C4b (CORRECTIONS.md item 20A) — client-safe shelf rules, labels and shapes.

/**
 * A shelf code: 2–4 parts of capital letters/digits joined by hyphens —
 * A-2-3 = rack A, shelf 2, box 3. The hyphen is required: a dress tag's SKU
 * is capital letters and digits only (lib/barcode/scan.ts), so a scanned
 * shelf label can never be mistaken for a dress. Held by a DB CHECK too.
 */
export const SHELF_CODE_PATTERN = /^[A-Z0-9]{1,4}(-[A-Z0-9]{1,4}){1,3}$/;
export const SHELF_CODE_MESSAGE = "A shelf code is parts of letters/digits joined by hyphens, like A-2-3 (rack A, shelf 2, box 3)";

/** Upper-cases and tidies a typed or scanned shelf code; null when it can't be one. */
export function normalizeShelfCode(raw: string): string | null {
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  return SHELF_CODE_PATTERN.test(cleaned) ? cleaned : null;
}

/** Natural order: A-2-10 after A-2-9. */
export function compareShelfCodes(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

/** "A", 1–4 shelves, 1–3 boxes → A-1-1 … A-4-3. No boxes → A-1 … A-4. */
export function generateShelfCodes(rack: string, shelves: number, boxes: number): string[] {
  const codes: string[] = [];
  for (let s = 1; s <= shelves; s++) {
    if (boxes <= 0) codes.push(`${rack}-${s}`);
    else for (let b = 1; b <= boxes; b++) codes.push(`${rack}-${s}-${b}`);
  }
  return codes;
}

export const MISS_CLOSE_REASONS = {
  FOUND: "Found and put on a shelf",
  LEFT_LOCATION: "Left the location (sold, packed or sent)",
  WRITTEN_OFF: "Written off",
  LOCATION_COUNT: "Settled by a location count",
  SHELVES_OFF: "Shelves switched off at the location",
} as const;
export type MissCloseReason = keyof typeof MISS_CLOSE_REASONS;

/** One shelf's share of a variant at a location. */
export type ShelfSpot = { shelfId: string; code: string; qty: number };

/** What the shelf chips show (components/shelves/shelf-spots.tsx): fullest shelf first, then Unassigned. */
export type ShelfSpotsValue = { shelves: { code: string; qty: number }[]; unassigned: number; notOnShelf: number };

/** Where a variant is inside one shelf-using location. Never carries cost. */
export type ShelfWhereabouts = {
  locationId: string;
  shelves: ShelfSpot[];
  /** Location stock − shelves (derived). Includes notOnShelf. */
  unassigned: number;
  /** Units a shelf count didn't find on their shelf — part of unassigned. */
  notOnShelf: number;
};

export type ShelfListItem = {
  id: string;
  code: string;
  note: string | null;
  isActive: boolean;
  units: number;
  items: number;
  lastCountedAt: string | null;
  openCountId: string | null;
};

export type ShelfContentLine = {
  variantId: string;
  sku: string;
  productName: string;
  sizeName: string;
  colorName: string;
  colorHex: string;
  thumbPath: string | null;
  qty: number;
};

export type UnassignedLine = ShelfContentLine & { notOnShelf: number };

export type ShelfMissView = {
  id: string;
  shelfCode: string;
  qty: number;
  createdAt: string;
  item: Omit<ShelfContentLine, "qty">;
};

export type ShelfLocationView = {
  location: { id: string; name: string };
  shelves: ShelfListItem[];
  totals: { stock: number; shelved: number; unassigned: number; notOnShelf: number };
  unassigned: UnassignedLine[];
  misses: ShelfMissView[];
  can: { manage: boolean; putAway: boolean; count: boolean; writeOff: boolean };
};

export type ShelfCountLineView = Omit<ShelfContentLine, "qty"> & {
  scanned: boolean;
  /** Not scanned, and the shelf's figure for it moved during the count: left alone. */
  movedDuringCount: boolean;
  counted: number;
  /** The shelf's figure at the line's last scan (unscanned: now); frozen when finished. */
  expected: number;
  difference: number;
  result: { missing: number; placed: number; unplaced: number } | null;
};

export type ShelfCountView = {
  id: string;
  status: "OPEN" | "DONE" | "CANCELLED";
  shelf: { id: string; code: string };
  location: { id: string; name: string };
  createdByName: string | null;
  createdAt: string;
  finishedByName: string | null;
  finishedAt: string | null;
  lines: ShelfCountLineView[];
  totals: { counted: number; expected: number; missing: number; extra: number };
  can: { scan: boolean; finish: boolean };
};
