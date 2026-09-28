import "server-only";

import { getStockReport } from "@/lib/inventory/stock-report";
import { NOT_COUNTED_AS_SALE } from "@/lib/orders/list-presets";
import { getSetAvailabilityReport } from "@/lib/sets/service";
import { figure, orderScope, type BuildContext, type BuiltReport } from "@/lib/reports/shared";

// R4 Stock and R5 Outfit-set availability (PRD §4.15). Totals are
// shop-wide (the sum over locations — C3), with each variant's split by
// location alongside: what's on the shelf now, plus what moved in the
// period. Cost (unit cost, value at cost) is flagged costOnly and removed
// for anyone without product.cost.view.

const STATUS_LABEL = { OK: "In stock", LOW: "Low", OUT: "Out" } as const;
const SOLD_TYPES = ["SALE_OUT", "POS_SALE_OUT"] as const;
// C4 — a transfer only moves stock between places (its rows net to zero),
// so it is neither stock in nor stock out for the shop.
const INTERNAL_MOVES = ["TRANSFER_SEND", "TRANSFER_RECEIVE"] as const;

export async function buildStockReport(ctx: BuildContext): Promise<BuiltReport> {
  const f = ctx.filters;
  const [stock, moves, sold] = await Promise.all([
    getStockReport({ categoryId: f.categoryId, status: f.stock ?? "all", page: 1, pageSize: 100_000 }),
    ctx.db.stockMovement.groupBy({ by: ["variantId"], where: { createdAt: { gte: f.from, lt: f.to }, qty: { gt: 0 }, type: { notIn: [...INTERNAL_MOVES] } }, _sum: { qty: true } }),
    ctx.db.stockMovement.groupBy({ by: ["variantId", "type"], where: { createdAt: { gte: f.from, lt: f.to }, qty: { lt: 0 }, type: { notIn: [...INTERNAL_MOVES] } }, _sum: { qty: true } }),
  ]);
  const inQty = new Map(moves.map((m) => [m.variantId, m._sum.qty ?? 0]));
  const outQty = new Map<string, number>();
  const soldQty = new Map<string, number>();
  for (const m of sold) {
    const q = -(m._sum.qty ?? 0);
    outQty.set(m.variantId, (outQty.get(m.variantId) ?? 0) + q);
    if ((SOLD_TYPES as readonly string[]).includes(m.type)) soldQty.set(m.variantId, (soldQty.get(m.variantId) ?? 0) + q);
  }

  const rows = stock.items.map((v) => ({
    product: v.productName,
    sku: v.sku,
    variant: `${v.sizeName} · ${v.colorName}`,
    category: v.categoryName ?? "—",
    // C3 — where it is (only locations with a non-zero figure).
    where: [...v.byLocation.map((b) => `${b.name} ${b.qty}`), ...(v.inTransit > 0 ? [`In transit ${v.inTransit}`] : [])].join(" · ") || "—",
    // Raw SQL can hand back a BigInt (COALESCE with a bound parameter); JSON can't carry one.
    onHand: Number(v.stockQty),
    reserved: Number(v.reservedQty),
    available: Number(v.available),
    threshold: Number(v.threshold),
    status: STATUS_LABEL[v.status],
    unitCost: v.weightedAvgCost ?? null,
    valueAtCost: v.valueAtCost ?? null,
    periodIn: inQty.get(v.variantId) ?? 0,
    periodOut: outQty.get(v.variantId) ?? 0,
    sold: soldQty.get(v.variantId) ?? 0,
    _href: `/catalog/products/${v.productId}`,
  }));
  const low = rows.filter((r) => r.status !== STATUS_LABEL.OK);
  const lowCount = stock.items.filter((v) => v.status === "LOW").length;
  const outCount = stock.items.filter((v) => v.status === "OUT").length;
  const sum = (k: "periodIn" | "periodOut" | "sold") => rows.reduce((a, r) => a + r[k], 0);

  return {
    figures: [
      figure("Variants", stock.totals.variants, "int"),
      figure("On hand", stock.totals.onHand, "int"),
      figure("Reserved", stock.totals.reserved, "int", { hint: "confirmed, not yet packed" }),
      figure("Available", stock.totals.available, "int"),
      figure("Value at cost", stock.totals.valueAtCost ?? null, "money", { costOnly: true }),
      figure("Low / out", `${lowCount} / ${outCount}`, "text", { href: "/inventory/low-stock" }),
    ],
    tables: [
      {
        id: "per-variant",
        title: "Per variant",
        columns: [
          { key: "product", label: "Product" },
          { key: "sku", label: "SKU" },
          { key: "variant", label: "Size · colour" },
          { key: "category", label: "Category" },
          { key: "where", label: "By location" },
          { key: "onHand", label: "On hand", format: "int" },
          { key: "reserved", label: "Reserved", format: "int" },
          { key: "available", label: "Available", format: "int" },
          { key: "status", label: "Status" },
          { key: "unitCost", label: "Unit cost", format: "money", costOnly: true },
          { key: "valueAtCost", label: "Value at cost", format: "money", costOnly: true },
          { key: "periodIn", label: "In (period)", format: "int" },
          { key: "periodOut", label: "Out (period)", format: "int" },
          { key: "sold", label: "Sold (period)", format: "int" },
        ],
        rows,
        totals: { product: "Total", onHand: stock.totals.onHand, reserved: stock.totals.reserved, available: stock.totals.available, valueAtCost: stock.totals.valueAtCost ?? null, periodIn: sum("periodIn"), periodOut: sum("periodOut"), sold: sum("sold") },
        empty: "No variants match these filters.",
      },
      {
        id: "low-stock",
        title: "Low-stock list",
        description: "Available at or below the variant's low-stock threshold.",
        columns: [
          { key: "product", label: "Product" },
          { key: "variant", label: "Size · colour" },
          { key: "sku", label: "SKU" },
          { key: "available", label: "Available", format: "int" },
          { key: "threshold", label: "Threshold", format: "int" },
          { key: "status", label: "Status" },
          { key: "sold", label: "Sold (period)", format: "int" },
        ],
        rows: low.map(({ product, variant, sku, available, threshold, status, sold, _href }) => ({ product, variant, sku, available, threshold, status, sold, _href })),
        empty: "Nothing is low on stock.",
      },
    ],
    notes: [
      "On hand, reserved and available are as of now, over every location (by location shows the split). In / out / sold are stock movements during the period (sold = packed online orders and counter sales).",
      ...(ctx.canSeeCost ? ["Value at cost = units on the shelf × weighted average cost (reserved units included — they're still ours until packed)."] : []),
    ],
  };
}

export async function buildSetsReport(ctx: BuildContext): Promise<BuiltReport> {
  const f = ctx.filters;
  const [sets, sold] = await Promise.all([
    getSetAvailabilityReport(ctx.db),
    // Sets sold in the period, on orders the user can see (an executive: their own).
    ctx.db.orderSetLine.groupBy({
      by: ["outfitSetId"],
      where: { order: orderScope(ctx.user, { deletedAt: null, exchangedFromOrderId: null, status: { notIn: NOT_COUNTED_AS_SALE }, createdAt: { gte: f.from, lt: f.to } }) },
      _sum: { qty: true },
    }),
  ]);
  const soldBy = new Map(sold.map((s) => [s.outfitSetId, s._sum.qty ?? 0]));
  const active = sets.filter((s) => s.isActive);
  return {
    figures: [
      figure("Active sets", active.length, "int"),
      figure("Sellable now", active.filter((s) => s.availableSets > 0).length, "int"),
      figure("Unavailable", active.filter((s) => s.availableSets <= 0).length, "int"),
      figure("Sets sold (period)", [...soldBy.values()].reduce((a, n) => a + n, 0), "int"),
    ],
    tables: [
      {
        id: "sets",
        title: "Availability per set",
        description: "How many complete sets the stock makes right now, and the component that runs out first.",
        columns: [
          { key: "name", label: "Set" },
          { key: "state", label: "State" },
          { key: "available", label: "Available sets", format: "int" },
          { key: "limiting", label: "Limited by" },
          { key: "sold", label: "Sold (period)", format: "int" },
        ],
        rows: sets.map((s) => ({ name: s.name, state: s.isActive ? "Active" : "Switched off", available: s.availableSets, limiting: s.limitingProduct ?? "—", sold: soldBy.get(s.id) ?? 0, _href: "/catalog" })),
        empty: "No outfit sets yet.",
      },
      {
        id: "components",
        title: "Components",
        description: "For each component, the size and colour with the most stock and how many sets it alone could make.",
        columns: [
          { key: "set", label: "Set" },
          { key: "component", label: "Component" },
          { key: "qty", label: "Per set", format: "int" },
          { key: "bestVariant", label: "Best size · colour" },
          { key: "bestAvailable", label: "Available", format: "int" },
          { key: "bestSets", label: "Sets it makes", format: "int" },
        ],
        rows: sets.flatMap((s) => s.components.map((c) => ({ set: s.name, component: c.productName, qty: c.qty, bestVariant: c.bestVariant ?? "—", bestAvailable: c.bestAvailable, bestSets: c.bestSets }))),
        empty: "No outfit sets yet.",
      },
    ],
    notes: ["Availability is as of now. Sold counts sets on the period's sales (not cancelled, returned or an exchange's replacement)."],
  };
}
