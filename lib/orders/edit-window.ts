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
export type GatedSetLine = { setId: string; qty: number; unitPrice: number; lineDiscount: number; choices: { productId: string; variantId: string }[] };

function normalizeSets(sets: GatedSetLine[]): string {
  return JSON.stringify(
    sets
      .map((s) => ({ setId: s.setId, qty: s.qty, unitPrice: s.unitPrice, lineDiscount: s.lineDiscount, choices: [...s.choices].map((c) => `${c.productId}:${c.variantId}`).sort() }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

export function editTouchesGatedFields(
  existing: { items: GatedEditItem[]; sets?: GatedSetLine[]; deliveryCharge: number },
  proposed: { items?: GatedEditItem[]; sets?: GatedSetLine[]; deliveryCharge?: number },
): boolean {
  if (proposed.items && normalizeItems(proposed.items) !== normalizeItems(existing.items)) return true;
  // P3.3 — an outfit set's quantity, price, discount or chosen sizes are lines too.
  if (proposed.sets && normalizeSets(proposed.sets) !== normalizeSets(existing.sets ?? [])) return true;
  if (proposed.deliveryCharge !== undefined && proposed.deliveryCharge !== existing.deliveryCharge) return true;
  return false;
}
