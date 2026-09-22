import "server-only";

// PRD §4.6: "an SE may freely edit an order for X minutes after creation
// (default 30, set in Settings). After that, any edit that changes
// items/price/discount/delivery charge needs TL/Admin approval."

export function isWithinEditWindow(createdAt: Date, windowMinutes: number, now: Date = new Date()): boolean {
  const elapsedMs = now.getTime() - createdAt.getTime();
  return elapsedMs <= windowMinutes * 60_000;
}

export type GatedEditItem = { variantId: string; qty: number; unitPrice: number; lineDiscount: number };

// Order-insensitive structural compare: the same set of lines in a
// different order isn't a "change" for the purposes of gating (avoids
// forcing a TL-approval request just because a resubmitted form serialized
// the array differently).
function normalizeItems(items: GatedEditItem[]): string {
  return JSON.stringify(
    [...items]
      .map((i) => ({ variantId: i.variantId, qty: i.qty, unitPrice: i.unitPrice, lineDiscount: i.lineDiscount }))
      .sort((a, b) => (a.variantId + a.unitPrice + a.qty).localeCompare(b.variantId + b.unitPrice + b.qty)),
  );
}

/**
 * True if the proposed edit actually touches items, price, discount, or
 * delivery charge (PRD §4.6's gated field list) relative to the order's
 * current state — not merely whether those keys were present in the
 * request body, since the order form always resubmits the full item list.
 */
export function editTouchesGatedFields(
  existing: { items: GatedEditItem[]; deliveryCharge: number },
  proposed: { items?: GatedEditItem[]; deliveryCharge?: number },
): boolean {
  if (proposed.items && normalizeItems(proposed.items) !== normalizeItems(existing.items)) return true;
  if (proposed.deliveryCharge !== undefined && proposed.deliveryCharge !== existing.deliveryCharge) return true;
  return false;
}
