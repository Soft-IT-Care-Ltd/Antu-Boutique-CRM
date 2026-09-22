import type { OrderStatusValue } from "@/lib/orders/constants";

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
  packedAt: string | null;
  packedBy: { id: string; name: string } | null;
};

export function packingUploadUrl(relativePath: string): string {
  return `/uploads/${relativePath}`;
}
