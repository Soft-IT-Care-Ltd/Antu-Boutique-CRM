// Pure purchase-costing math (PRD §4.3). No DB, no "server-only" — shared by
// the purchase service, the purchase form's live preview and prisma/seed.ts.
//
// Everything is done in integer paisa so a ৳ 0.01 never goes missing:
// allocation uses the largest-remainder method, so the per-line shares
// always add back up to exactly the transport/other total.

export type AllocationMethod = "BY_VALUE" | "BY_QTY";

type MoneyLike = number | string | { toString(): string };

export function toPaisa(amount: MoneyLike): number {
  const value = typeof amount === "number" ? amount : Number(amount.toString());
  return Math.round(value * 100);
}

export function fromPaisa(paisa: number): string {
  const sign = paisa < 0 ? "-" : "";
  const abs = Math.abs(paisa);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * PRD §4.3: new_wac = (old_qty × old_wac + in_qty × in_cost) ÷ (old_qty + in_qty).
 *
 * When there is no positive stock on hand (zero, or negative after a
 * stock-override sale), the old cost describes nothing on the shelf, so the
 * incoming cost becomes the new average outright — blending against a
 * negative quantity would produce a meaningless (even negative) cost.
 */
export function computeWeightedAverageCostPaisa(oldQty: number, oldWacPaisa: number, inQty: number, inCostPaisa: number): number {
  if (!Number.isInteger(inQty) || inQty <= 0) throw new Error("Incoming quantity must be a positive integer");
  if (oldQty <= 0) return inCostPaisa;
  return Math.round((oldQty * oldWacPaisa + inQty * inCostPaisa) / (oldQty + inQty));
}

export function computeWeightedAverageCost(oldQty: number, oldWac: MoneyLike, inQty: number, inCost: MoneyLike): string {
  return fromPaisa(computeWeightedAverageCostPaisa(oldQty, toPaisa(oldWac), inQty, toPaisa(inCost)));
}

/** Splits `totalPaisa` across `weights` proportionally; shares always sum to exactly `totalPaisa`. */
export function splitProportionally(totalPaisa: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) return splitProportionally(totalPaisa, weights.map(() => 1));

  const raw = weights.map((w) => (totalPaisa * w) / weightSum);
  const shares = raw.map(Math.floor);
  let remainder = totalPaisa - shares.reduce((a, b) => a + b, 0);
  const byFraction = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0; k = (k + 1) % byFraction.length, remainder--) {
    shares[byFraction[k].i] += 1;
  }
  return shares;
}

export type PurchaseLineInput = { qty: number; unitCost: MoneyLike };

export type CostedPurchaseLine = {
  qty: number;
  unitCostPaisa: number;
  lineCostPaisa: number;
  allocatedPaisa: number;
  /** (line cost + allocated share) ÷ qty, rounded to the paisa — what feeds WAC and the PURCHASE_IN ledger row. */
  landedUnitCostPaisa: number;
};

export type CostedPurchase = {
  lines: CostedPurchaseLine[];
  itemsSubtotalPaisa: number;
  extraCostPaisa: number;
  totalCostPaisa: number;
};

/**
 * Prices a purchase: per-line cost, each line's share of transport + other
 * cost (by line value, or by qty), and the landed unit cost that goes into
 * the weighted average. BY_VALUE falls back to BY_QTY when every line is
 * free (no value to weight by).
 */
export function costPurchase(
  lines: PurchaseLineInput[],
  transportCost: MoneyLike,
  otherCost: MoneyLike,
  method: AllocationMethod,
): CostedPurchase {
  const base = lines.map((line) => {
    const unitCostPaisa = toPaisa(line.unitCost);
    return { qty: line.qty, unitCostPaisa, lineCostPaisa: unitCostPaisa * line.qty };
  });

  const extraCostPaisa = toPaisa(transportCost) + toPaisa(otherCost);
  const weights = method === "BY_VALUE" ? base.map((l) => l.lineCostPaisa) : base.map((l) => l.qty);
  const allocations = splitProportionally(extraCostPaisa, weights);

  const costed = base.map((line, i) => ({
    ...line,
    allocatedPaisa: allocations[i],
    landedUnitCostPaisa: line.qty > 0 ? Math.round((line.lineCostPaisa + allocations[i]) / line.qty) : 0,
  }));

  const itemsSubtotalPaisa = costed.reduce((sum, l) => sum + l.lineCostPaisa, 0);
  return { lines: costed, itemsSubtotalPaisa, extraCostPaisa, totalCostPaisa: itemsSubtotalPaisa + extraCostPaisa };
}
