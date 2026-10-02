// C5 — client-safe fulfilment labels and shapes (CORRECTIONS.md items 12, 13).

export const FULFILMENT_STATUS_VALUES = ["READY_TO_PACK", "NEEDS_TRANSFER", "WAITING_FOR_STOCK"] as const;
export type FulfilmentStatusValue = (typeof FULFILMENT_STATUS_VALUES)[number];

export const FULFILMENT_STATUS_LABELS: Record<FulfilmentStatusValue, string> = {
  READY_TO_PACK: "Ready to pack",
  NEEDS_TRANSFER: "Needs transfer",
  WAITING_FOR_STOCK: "Waiting for stock",
};

export const FULFILMENT_STATUS_TONE: Record<FulfilmentStatusValue, "default" | "secondary" | "destructive" | "outline"> = {
  READY_TO_PACK: "secondary",
  NEEDS_TRANSFER: "outline",
  WAITING_FOR_STOCK: "destructive",
};

export const FULFILMENT_ACTION_LABELS = {
  SUBSTITUTE: "Substitute",
  WAIT: "Wait",
  REMOVE_ITEM: "Remove item",
  CANCEL: "Cancel for stock-out",
} as const;
export type FulfilmentActionKindValue = keyof typeof FULFILMENT_ACTION_LABELS;

/** Where a line's units come from (stored on the line by lib/fulfilment/settle.ts). */
export type LineFulfilment = {
  atHub: number;
  incoming: number;
  /** Units at other locations, by location name. */
  fromLocations: { locationId: string; locationName: string; qty: number }[];
  backorder: number;
};
