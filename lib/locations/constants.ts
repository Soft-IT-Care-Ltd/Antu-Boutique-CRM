// CORRECTIONS.md item 2 — client-safe location shapes and labels.

export const LOCATION_TYPES = ["WAREHOUSE", "SHOP", "SALES_CORNER", "STUDIO"] as const;
export type LocationTypeValue = (typeof LOCATION_TYPES)[number];

export const LOCATION_TYPE_LABELS: Record<LocationTypeValue, string> = {
  WAREHOUSE: "Warehouse",
  SHOP: "Shop",
  SALES_CORNER: "Sales corner",
  STUDIO: "Studio",
};

/** The starting locations' fixed ids (migration 20261003090000_stock_locations). */
export const SEEDED_LOCATION_IDS = {
  mohammadpur: "loc_mohammadpur",
  shyamoli: "loc_shyamoli",
  parlour: "loc_parlour",
  studio: "loc_studio",
} as const;

export type LocationOption = {
  id: string;
  name: string;
  type: LocationTypeValue;
  isPackingHub: boolean;
  hasPos: boolean;
  isActive: boolean;
};

/** One location's share of a variant's stock. */
export type LocationQty = { locationId: string; name: string; qty: number };
