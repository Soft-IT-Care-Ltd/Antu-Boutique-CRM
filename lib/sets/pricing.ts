import { allocatePaisa } from "@/lib/expenses/allocate";

// P3.3 — how an outfit set's price becomes its components' order lines.
// Pure and client-safe: the POS and order form preview with it, the server
// decides with it.
//
// A set sold on an order is one set line (name, qty, set price, discount)
// plus one ordinary order line per component: the chosen size/colour, with
// its share of the price. The order total is still the sum of its lines,
// and a component can be returned or exchanged on its own for exactly what
// it was worth inside the set.
//
// The set price splits over the components in proportion to their list
// value (product price × units per set), in whole paisa that add back up to
// the set price. A component line needs a whole-paisa unit price, so its
// unit price is rounded UP and the few paisa over go into its line
// discount, with its share of the set line's own discount. So, exactly:
//   Σ (component qty × unit price − component discount) = set price × qty − set discount

export type SetComponentForPricing = {
  /** Anything unique per component (its product id). */
  key: string;
  /** Units of this component in ONE set. */
  qtyPerSet: number;
  /** The component's list value per unit, to weight the split (0 → equal split). */
  listPricePaisa: number;
};

export type PricedSetComponent = {
  key: string;
  /** Units on the order line: qtyPerSet × sets sold. */
  qty: number;
  unitPricePaisa: number;
  discountPaisa: number;
  /** What this line is worth after discount. */
  netPaisa: number;
};

export function priceSetComponents(input: { unitPricePaisa: number; qty: number; discountPaisa: number; components: SetComponentForPricing[] }): PricedSetComponent[] {
  const { unitPricePaisa, qty, discountPaisa, components } = input;
  if (components.length === 0) return [];
  if (!Number.isInteger(qty) || qty < 1) throw new Error("A set line needs a whole quantity of at least 1.");
  if (discountPaisa < 0 || discountPaisa > unitPricePaisa * qty) throw new Error("The set's discount can't be more than the set line.");

  // Each component's share of ONE set's price.
  const perSet = allocatePaisa(
    unitPricePaisa,
    components.map((c) => ({ id: c.key, valuePaisa: c.listPricePaisa * c.qtyPerSet })),
    "BY_VALUE",
  );
  // The set line's discount, split the same way.
  const discountShare = allocatePaisa(
    discountPaisa,
    components.map((c) => ({ id: c.key, valuePaisa: (perSet.get(c.key) ?? 0) * qty })),
    "BY_VALUE",
  );

  return components.map((c) => {
    const share = perSet.get(c.key) ?? 0;
    const unit = Math.ceil(share / c.qtyPerSet);
    const lineQty = c.qtyPerSet * qty;
    const rounding = unit * lineQty - share * qty;
    const discount = rounding + (discountShare.get(c.key) ?? 0);
    return { key: c.key, qty: lineQty, unitPricePaisa: unit, discountPaisa: discount, netPaisa: unit * lineQty - discount };
  });
}

/** Sets of one chosen combination that can be sold: min over components of floor(available ÷ units per set). */
export function setsAvailable(components: { available: number; qtyPerSet: number }[]): number {
  if (components.length === 0) return 0;
  return Math.max(0, Math.min(...components.map((c) => Math.floor(Math.max(0, c.available) / c.qtyPerSet))));
}
