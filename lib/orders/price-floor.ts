// PRD §4.6 section 2: "unit price ... editable down to the price floor."
// The PRD doesn't spell out what the floor is, so this reads it as the
// variant's own cost: a Sales Executive can discount freely but can't
// (even unknowingly, since they never see the cost number — CLAUDE.md rule
// 5) price a line below what the item cost the business. Anyone who
// already holds product.cost.view (Admin/Manager) is trusted to
// consciously sell below cost, so the floor doesn't apply to them.
export function isPriceBelowFloor(unitPrice: number, cost: number, hasCostAccess: boolean): boolean {
  if (hasCostAccess) return false;
  return unitPrice < cost;
}
