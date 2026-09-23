import type { AdAllocationMethod } from "@/lib/expenses/constants";

/**
 * Splits `totalPaisa` over `items` — equally, or in proportion to each
 * item's value — in whole paisa that always add back up to the total
 * (largest remainder: the leftover paisa go to the biggest fractions, ties
 * to the earlier item). BY_VALUE with nothing of value falls back to equal.
 */
export function allocatePaisa<T extends { id: string; valuePaisa: number }>(totalPaisa: number, items: T[], method: AdAllocationMethod): Map<string, number> {
  const out = new Map<string, number>();
  if (items.length === 0 || totalPaisa <= 0) {
    for (const item of items) out.set(item.id, 0);
    return out;
  }
  const byValue = method === "BY_VALUE" && items.some((i) => i.valuePaisa > 0);
  const weights = items.map((i) => (byValue ? Math.max(0, i.valuePaisa) : 1));
  const weightSum = weights.reduce((a, b) => a + b, 0);

  const shares = items.map((item, index) => {
    const exact = (totalPaisa * weights[index]) / weightSum;
    return { id: item.id, index, base: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  let leftover = totalPaisa - shares.reduce((a, s) => a + s.base, 0);
  const byFraction = [...shares].sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const share of byFraction) {
    if (leftover <= 0) break;
    share.base += 1;
    leftover -= 1;
  }
  for (const share of shares) out.set(share.id, share.base);
  return out;
}
