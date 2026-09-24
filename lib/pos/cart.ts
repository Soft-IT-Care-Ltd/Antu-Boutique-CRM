import { allocatePaisa } from "@/lib/expenses/allocate";
import { toPaisa } from "@/lib/inventory/costing";

// PRD §4.7 — the POS cart's money, in whole paisa. Pure and client-safe:
// the screen shows exactly what the server will charge, and the server
// recomputes it from the lines (never trusting the client's totals).

export type CartLineInput = { key: string; qty: number; unitPrice: number; lineDiscount: number };

export type PricedCartLine = {
  key: string;
  qty: number;
  unitPricePaisa: number;
  grossPaisa: number;
  /** The line's own discount plus its share of the cart discount. */
  discountPaisa: number;
  netPaisa: number;
};

export type PricedCart = { lines: PricedCartLine[]; subtotalPaisa: number; discountPaisa: number; totalPaisa: number };

export class CartError extends Error {}

/**
 * A cart-wide discount (e.g. "৳200 off the lot") is spread over the lines in
 * proportion to what's left of each after its own discount, largest
 * remainder, so every line carries its part: the order keeps one discount
 * per line (order_items.lineDiscount) and per-line profit stays true.
 */
export function priceCart(lines: CartLineInput[], cartDiscount: number): PricedCart {
  const base = lines.map((l) => {
    const unitPricePaisa = toPaisa(l.unitPrice);
    const grossPaisa = l.qty * unitPricePaisa;
    const ownDiscount = toPaisa(l.lineDiscount);
    if (ownDiscount > grossPaisa) throw new CartError("A line's discount can't be more than the line itself.");
    return { key: l.key, qty: l.qty, unitPricePaisa, grossPaisa, ownDiscount };
  });

  const cartPaisa = toPaisa(cartDiscount);
  const afterOwn = base.reduce((a, l) => a + l.grossPaisa - l.ownDiscount, 0);
  if (cartPaisa > afterOwn) throw new CartError("The discount can't be more than the sale.");

  const shares = allocatePaisa(
    cartPaisa,
    base.map((l) => ({ id: l.key, valuePaisa: l.grossPaisa - l.ownDiscount })),
    "BY_VALUE",
  );

  const priced = base.map((l) => {
    const discountPaisa = l.ownDiscount + (shares.get(l.key) ?? 0);
    return { key: l.key, qty: l.qty, unitPricePaisa: l.unitPricePaisa, grossPaisa: l.grossPaisa, discountPaisa, netPaisa: l.grossPaisa - discountPaisa };
  });
  const subtotalPaisa = priced.reduce((a, l) => a + l.grossPaisa, 0);
  const discountPaisa = priced.reduce((a, l) => a + l.discountPaisa, 0);
  return { lines: priced, subtotalPaisa, discountPaisa, totalPaisa: subtotalPaisa - discountPaisa };
}

export type TenderInput = { method: string; amount: number; tendered?: number | null };

export type SettledTenders = { paidPaisa: number; changePaisa: number; remainingPaisa: number };

/**
 * How the tenders settle a total. `amount` is what each tender pays toward
 * the sale; for cash, `tendered` is the note(s) handed over and the excess
 * is change. A sale completes only when the tenders pay the total exactly.
 */
export function settleTenders(totalPaisa: number, tenders: TenderInput[]): SettledTenders {
  let paidPaisa = 0;
  let changePaisa = 0;
  for (const t of tenders) {
    const amount = toPaisa(t.amount);
    paidPaisa += amount;
    if (t.method === "CASH" && t.tendered != null) changePaisa += Math.max(0, toPaisa(t.tendered) - amount);
  }
  return { paidPaisa, changePaisa, remainingPaisa: totalPaisa - paidPaisa };
}
