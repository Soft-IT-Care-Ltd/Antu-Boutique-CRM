import "server-only";

import { toPaisa } from "@/lib/inventory/costing";
import { categoryProducts, dhakaDay, figure, money, narrowOrders, orderScope, type BuildContext, type BuiltReport } from "@/lib/reports/shared";

// R15 Stock-outs — lost sales (C5, CORRECTIONS.md item 12): the value of
// items removed from orders, and of orders cancelled, because the stock
// wasn't there — by product. From the fulfilment actions themselves
// (fulfilment_actions REMOVE_ITEM / CANCEL rows, one per line, at what the
// line was worth to the customer), so it can't drift from what staff did.
// Substitutions kept the sale and are counted apart. Scoped like the orders
// they belong to (an executive: their own).

export async function buildStockOutsReport(ctx: BuildContext): Promise<BuiltReport> {
  const f = ctx.filters;
  const rows = await ctx.db.fulfilmentAction.findMany({
    where: {
      kind: { in: ["REMOVE_ITEM", "CANCEL", "SUBSTITUTE"] },
      createdAt: { gte: f.from, lt: f.to },
      order: orderScope(ctx.user, { ...narrowOrders({ ...f, categoryId: undefined }) }),
      ...(f.categoryId ? { variant: { product: categoryProducts(f.categoryId) } } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: {
      kind: true,
      qty: true,
      value: true,
      reason: true,
      createdAt: true,
      orderId: true,
      order: { select: { orderNo: true } },
      actor: { select: { name: true } },
      variant: { select: { sku: true, size: { select: { name: true } }, color: { select: { name: true } }, product: { select: { id: true, name: true } } } },
      substituteVariant: { select: { sku: true } },
    },
  });

  const lost = rows.filter((r) => r.kind !== "SUBSTITUTE");
  const swaps = rows.filter((r) => r.kind === "SUBSTITUTE");
  const products = new Map<string, { name: string; removedUnits: number; cancelledUnits: number; value: number; orders: Set<string> }>();
  let removedPaisa = 0;
  let cancelledPaisa = 0;
  for (const r of lost) {
    const paisa = toPaisa(r.value);
    if (r.kind === "CANCEL") cancelledPaisa += paisa;
    else removedPaisa += paisa;
    const key = r.variant?.product.id ?? "";
    const p = products.get(key) ?? { name: r.variant?.product.name ?? "—", removedUnits: 0, cancelledUnits: 0, value: 0, orders: new Set<string>() };
    if (r.kind === "CANCEL") p.cancelledUnits += r.qty;
    else p.removedUnits += r.qty;
    p.value += paisa;
    p.orders.add(r.orderId);
    products.set(key, p);
  }
  const cancelledOrders = new Set(lost.filter((r) => r.kind === "CANCEL").map((r) => r.orderId));

  return {
    figures: [
      figure("Lost sales", money(removedPaisa + cancelledPaisa), "money", { hint: "Items removed and orders cancelled because the stock wasn't there" }),
      figure("Items removed", money(removedPaisa), "money"),
      figure("Orders cancelled for a stock-out", cancelledOrders.size, "int"),
      figure("Value of those orders", money(cancelledPaisa), "money"),
      figure("Substitutions (sale kept)", swaps.length, "int"),
    ],
    tables: [
      {
        id: "by-product",
        title: "Lost sales by product",
        columns: [
          { key: "product", label: "Product" },
          { key: "removedUnits", label: "Units removed", format: "int" },
          { key: "cancelledUnits", label: "Units on cancelled orders", format: "int" },
          { key: "orders", label: "Orders", format: "int" },
          { key: "value", label: "Value lost", format: "money" },
        ],
        rows: [...products.values()]
          .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
          .map((p) => ({ product: p.name, removedUnits: p.removedUnits, cancelledUnits: p.cancelledUnits, orders: p.orders.size, value: money(p.value) })),
        totals: { product: "Total", removedUnits: lost.filter((r) => r.kind === "REMOVE_ITEM").reduce((s, r) => s + r.qty, 0), cancelledUnits: lost.filter((r) => r.kind === "CANCEL").reduce((s, r) => s + r.qty, 0), orders: new Set(lost.map((r) => r.orderId)).size, value: money(removedPaisa + cancelledPaisa) },
        empty: "No sale was lost to a stock-out in this period.",
      },
      {
        id: "lines",
        title: "Every item removed or cancelled",
        columns: [
          { key: "day", label: "Date", format: "day" },
          { key: "orderNo", label: "Order" },
          { key: "what", label: "What" },
          { key: "item", label: "Item" },
          { key: "qty", label: "Qty", format: "int" },
          { key: "value", label: "Value", format: "money" },
          { key: "reason", label: "Reason" },
          { key: "by", label: "By" },
        ],
        rows: lost.map((r) => ({
          _href: `/orders/${r.orderId}`,
          day: dhakaDay(r.createdAt),
          orderNo: r.order.orderNo,
          what: r.kind === "CANCEL" ? "Order cancelled" : "Item removed",
          item: r.variant ? `${r.variant.product.name} · ${r.variant.size.name} / ${r.variant.color.name} (${r.variant.sku})` : "—",
          qty: r.qty,
          value: money(toPaisa(r.value)),
          reason: r.reason,
          by: r.actor.name,
        })),
        empty: "No sale was lost to a stock-out in this period.",
      },
      {
        id: "substitutions",
        title: "Substitutions",
        description: "The customer agreed to another item — the sale was kept.",
        columns: [
          { key: "day", label: "Date", format: "day" },
          { key: "orderNo", label: "Order" },
          { key: "from", label: "Missing" },
          { key: "to", label: "Sent instead" },
          { key: "reason", label: "Reason" },
        ],
        rows: swaps.map((r) => ({ _href: `/orders/${r.orderId}`, day: dhakaDay(r.createdAt), orderNo: r.order.orderNo, from: r.variant ? `${r.qty} × ${r.variant.sku}` : "—", to: r.substituteVariant?.sku ?? "—", reason: r.reason })),
        empty: "No substitutions in this period.",
      },
    ],
    notes: [
      "Lost sales come from the fulfilment actions on orders (Remove item, Cancel for stock-out), each line at what it was worth to the customer (price × qty − its discount). A cancelled order counts every line on it.",
      "Dated by when the action was taken (Dhaka days). Orders are scoped to who may see them.",
    ],
  };
}
