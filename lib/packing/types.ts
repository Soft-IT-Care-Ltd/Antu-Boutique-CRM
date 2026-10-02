import type { OrderStatusValue } from "@/lib/orders/constants";
import type { ShelfSpotsValue } from "@/lib/shelves/constants";

// Client-side shapes mirroring /api/packing/*'s JSON — deliberately its own
// module rather than reusing lib/orders/types.ts's OrderDetail/OrderListItem:
// PRD §4.8 "Packing must not see customer money data beyond what's printed
// on the packing slip," so these types simply have no field to hold total,
// dueAmount, unitPrice or payments in the first place — nothing to strip,
// nothing to accidentally render.

// Mirrors lib/orders/pack.ts's PackingChecklistKey/PackingChecklist —
// duplicated rather than imported so this client-safe module never pulls
// in a "server-only" source file, even as a type-only import.
export const PACKING_CHECKLIST_KEYS = ["itemsMatch", "imageMatched", "qualityChecked", "invoicePrinted"] as const;
export type PackingChecklistKey = (typeof PACKING_CHECKLIST_KEYS)[number];
export type PackingChecklist = Record<PackingChecklistKey, boolean>;

// P4.3 — the packing screen's views, each one a number on the Packing
// dashboard: the queue itself, the part of it past the SLA, parcels packed
// and waiting for the courier, and what was packed today.
export const PACKING_VIEWS = ["queue", "overdue", "ready", "packed_today"] as const;
export type PackingView = (typeof PACKING_VIEWS)[number];

export const PACKING_VIEW_LABELS: Record<PackingView, string> = {
  queue: "To pack",
  overdue: "Overdue",
  ready: "Ready to hand over",
  packed_today: "Packed today",
};

export type PackingImageView = {
  id: string;
  filePath: string;
  thumbPath: string;
  caption: string | null;
};

export type PackingItemView = {
  id: string;
  productName: string;
  sku: string;
  sizeName: string;
  colorName: string;
  colorHex: string;
  qty: number;
  /** P3.3 — the outfit set this line belongs to (its components are listed one by one). */
  set: { id: string; name: string; qty: number } | null;
  /** C4b — where it sits at the packing hub (shelves, then Unassigned); null once packed or without shelves. */
  shelves: ShelfSpotsValue | null;
};

export type PackingQueueItem = {
  id: string;
  orderNo: string;
  customer: { name: string; phone: string };
  internalNote: string | null;
  items: PackingItemView[];
  images: PackingImageView[];
  createdAt: string;
  hoursOpen: number;
  isOverdue: boolean;
  /** Once packed: when (the latest PACKED move) — the ready / packed-today views show it instead of the SLA. */
  packedAt: string | null;
  /** C5 — while confirmed: Ready to pack / Needs transfer / Waiting for stock (only Ready can be packed). */
  fulfilmentStatus: "READY_TO_PACK" | "NEEDS_TRANSFER" | "WAITING_FOR_STOCK" | null;
};

export type PackingOrderDetail = PackingQueueItem & {
  status: OrderStatusValue;
  customer: PackingQueueItem["customer"] & {
    altPhone: string | null;
    division: string | null;
    district: string | null;
    thana: string | null;
    addressDetail: string | null;
  };
  packedBy: { id: string; name: string } | null;
  /** P3.3 — bags, boxes, tissue and tags: used (once packed) or to use. */
  packaging: { label: string; sku: string; qty: number }[];
};

export function packingUploadUrl(relativePath: string): string {
  return `/uploads/${relativePath}`;
}
