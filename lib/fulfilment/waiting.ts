import "server-only";

import type { Prisma } from "@prisma/client";

import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import type { Db } from "@/lib/db/tx";
import { ALLOCATED_ORDERS } from "@/lib/fulfilment/allocation";
import { settleIfPending } from "@/lib/fulfilment/settle";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";

// C5 — CORRECTIONS.md item 12, the "Waiting for stock" page: every order
// with a piece that isn't in stock anywhere — customer, missing items,
// order value, days waiting — and the totals: how many orders, their parcel
// value, and how many of each size/colour are needed (to print, export, or
// pre-fill a purchase). Scoped like every order list (CLAUDE.md rule 6): an
// executive sees their own waiting orders, a team leader their team's.

export type WaitingItem = { variantId: string; sku: string; productName: string; sizeName: string; colorName: string; colorHex: string; qty: number };

export type WaitingOrderRow = {
  orderId: string;
  orderNo: string;
  customerName: string | null;
  customerPhone: string | null;
  createdByName: string | null;
  placedAt: string;
  waitingSince: string | null;
  daysWaiting: number;
  expectedOn: string | null;
  total: string;
  missing: WaitingItem[];
};

export type WaitingNeed = WaitingItem & { orders: number };

export type WaitingForStock = {
  orders: WaitingOrderRow[];
  totals: { orders: number; parcelValue: string; units: number };
  /** Per size/colour: how many the waiting orders need, most needed first. */
  needs: WaitingNeed[];
};

const DAY_MS = 86_400_000;

export async function getWaitingForStock(db: Db, user: SessionUser, now = new Date()): Promise<WaitingForStock> {
  await settleIfPending(db);
  const rows = await db.order.findMany({
    where: scopedWhere({ ...ALLOCATED_ORDERS, fulfilmentStatus: "WAITING_FOR_STOCK" }, user) as Prisma.OrderWhereInput,
    // Oldest waiting first: they get the stock first too.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      orderNo: true,
      createdAt: true,
      waitingSince: true,
      stockExpectedOn: true,
      total: true,
      customer: { select: { name: true, phone: true } },
      createdBy: { select: { name: true } },
      items: {
        where: { backorderQty: { gt: 0 } },
        orderBy: { createdAt: "asc" },
        select: { backorderQty: true, variant: { select: { id: true, sku: true, size: { select: { name: true } }, color: { select: { name: true, hexCode: true } }, product: { select: { name: true } } } } },
      },
    },
  });

  const needs = new Map<string, WaitingNeed & { orderIds: Set<string> }>();
  let valuePaisa = 0;
  const orders = rows.map((o) => {
    valuePaisa += toPaisa(o.total);
    const missing = o.items.map((i) => ({
      variantId: i.variant.id,
      sku: i.variant.sku,
      productName: i.variant.product.name,
      sizeName: i.variant.size.name,
      colorName: i.variant.color.name,
      colorHex: i.variant.color.hexCode,
      qty: i.backorderQty,
    }));
    for (const m of missing) {
      const n = needs.get(m.variantId) ?? { ...m, qty: 0, orders: 0, orderIds: new Set<string>() };
      n.qty += m.qty;
      n.orderIds.add(o.id);
      n.orders = n.orderIds.size;
      needs.set(m.variantId, n);
    }
    const since = o.waitingSince ?? o.createdAt;
    return {
      orderId: o.id,
      orderNo: o.orderNo,
      customerName: o.customer?.name ?? null,
      customerPhone: o.customer?.phone ?? null,
      createdByName: o.createdBy?.name ?? null,
      placedAt: o.createdAt.toISOString(),
      waitingSince: o.waitingSince?.toISOString() ?? null,
      daysWaiting: Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY_MS)),
      expectedOn: o.stockExpectedOn?.toISOString() ?? null,
      total: o.total.toFixed(2),
      missing,
    };
  });
  const needList = [...needs.values()]
    .map((n): WaitingNeed => ({ variantId: n.variantId, sku: n.sku, productName: n.productName, sizeName: n.sizeName, colorName: n.colorName, colorHex: n.colorHex, qty: n.qty, orders: n.orders }))
    .sort((a, b) => b.qty - a.qty || a.productName.localeCompare(b.productName) || a.sku.localeCompare(b.sku));
  return {
    orders,
    totals: { orders: orders.length, parcelValue: fromPaisa(valuePaisa), units: needList.reduce((sum, n) => sum + n.qty, 0) },
    needs: needList,
  };
}

const csvCell = (v: string | number | null) => {
  const s = v === null ? "" : String(v);
  // A leading = + - @ would run as a formula in Excel.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** One row per missing size/colour per order, then the per-variant totals. */
export function waitingForStockCsv(w: WaitingForStock): string {
  const lines = [["order_no", "customer", "phone", "sales_executive", "placed", "days_waiting", "expected", "order_value", "sku", "product", "size", "colour", "qty_missing"].join(",")];
  for (const o of w.orders) {
    for (const m of o.missing) {
      lines.push(
        [o.orderNo, o.customerName, o.customerPhone, o.createdByName, o.placedAt.slice(0, 10), o.daysWaiting, o.expectedOn?.slice(0, 10) ?? null, o.total, m.sku, m.productName, m.sizeName, m.colorName, m.qty].map(csvCell).join(","),
      );
    }
  }
  lines.push("");
  lines.push(["sku", "product", "size", "colour", "qty_needed", "orders"].join(","));
  for (const n of w.needs) lines.push([n.sku, n.productName, n.sizeName, n.colorName, n.qty, n.orders].map(csvCell).join(","));
  return lines.join("\n") + "\n";
}
