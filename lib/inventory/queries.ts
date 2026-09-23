import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { PermissionKey } from "@/lib/auth/permission-definitions";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import type { StockMovementTypeValue } from "@/lib/inventory/constants";
import type { PurchaseDetail, PurchaseListItem, StockMovementRow, SupplierItem } from "@/lib/inventory/types";

// Who may read what in the inventory module. Kept here, next to the queries
// they gate, so routes and pages can't drift apart.
//
// - Stock report + low-stock alerts: inventory.view (SE/TL/Packing/POS
//   included — they need to know what's sellable; cost columns stripped).
// - Ledger: whoever moves stock by hand or by purchase. It names staff and
//   order numbers across every SE, so it stays off the SE/TL screens.
// - Purchases + suppliers: purchase recorders who can ALSO see cost — a
//   purchase is purchase price by definition, so a per-user GRANT of
//   inventory.purchase.create alone must not expose it.
export const LEDGER_VIEW_PERMISSIONS: PermissionKey[] = ["inventory.adjust", "inventory.purchase.create"];
export const PURCHASE_VIEW_PERMISSIONS: PermissionKey[] = ["inventory.purchase.create", "product.cost.view"];

export type MovementQuery = {
  q?: string;
  variantId?: string;
  type?: StockMovementTypeValue;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
};

export async function listStockMovements(query: MovementQuery): Promise<{ items: StockMovementRow[]; total: number }> {
  const and: Prisma.StockMovementWhereInput[] = [];
  if (query.variantId) and.push({ variantId: query.variantId });
  if (query.type) and.push({ type: query.type });
  if (query.from) and.push({ createdAt: { gte: query.from } });
  if (query.to) and.push({ createdAt: { lt: query.to } });
  if (query.q) {
    and.push({
      OR: [
        { variant: { sku: { contains: query.q, mode: "insensitive" } } },
        { variant: { product: { name: { contains: query.q, mode: "insensitive" } } } },
        { note: { contains: query.q, mode: "insensitive" } },
      ],
    });
  }
  const where: Prisma.StockMovementWhereInput = { AND: and };

  const [total, movements] = await Promise.all([
    prisma.stockMovement.count({ where }),
    prisma.stockMovement.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        actor: { select: { name: true } },
        variant: { include: { product: { select: { name: true } }, size: true, color: true } },
      },
    }),
  ]);

  const orderIds = movements.filter((m) => m.referenceType === "ORDER" && m.referenceId).map((m) => m.referenceId!);
  const purchaseIds = movements.filter((m) => m.referenceType === "PURCHASE" && m.referenceId).map((m) => m.referenceId!);
  const [orders, purchases] = await Promise.all([
    orderIds.length ? prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNo: true } }) : [],
    purchaseIds.length
      ? prisma.purchase.findMany({ where: { id: { in: purchaseIds } }, select: { id: true, invoiceNo: true, supplier: { select: { name: true } } } })
      : [],
  ]);
  const orderNoById = new Map(orders.map((o) => [o.id, o.orderNo]));
  const purchaseById = new Map(purchases.map((p) => [p.id, p]));

  const items: StockMovementRow[] = movements.map((m) => {
    let referenceLabel: string | null = null;
    let referenceHref: string | null = null;
    if (m.referenceType === "ORDER" && m.referenceId) {
      referenceLabel = orderNoById.get(m.referenceId) ?? null;
      referenceHref = `/orders/${m.referenceId}`;
    } else if (m.referenceType === "PURCHASE" && m.referenceId) {
      const p = purchaseById.get(m.referenceId);
      referenceLabel = p ? [p.supplier.name, p.invoiceNo].filter(Boolean).join(" · ") : null;
      referenceHref = `/inventory/purchases/${m.referenceId}`;
    }
    return {
      id: m.id,
      createdAt: m.createdAt.toISOString(),
      type: m.type,
      qty: m.qty,
      stockAfter: m.stockAfter,
      unitCostSnapshot: m.unitCostSnapshot.toString(),
      referenceType: m.referenceType,
      referenceId: m.referenceId,
      referenceLabel,
      referenceHref,
      note: m.note,
      actorName: m.actor?.name ?? null,
      variant: {
        id: m.variant.id,
        sku: m.variant.sku,
        productName: m.variant.product.name,
        sizeName: m.variant.size.name,
        colorName: m.variant.color.name,
        colorHex: m.variant.color.hexCode,
      },
    };
  });

  return { items, total };
}

export async function listSuppliers(options: { includeInactive: boolean; q?: string }): Promise<SupplierItem[]> {
  const suppliers = await prisma.supplier.findMany({
    where: {
      ...(options.includeInactive ? {} : { isActive: true }),
      ...(options.q ? { OR: [{ name: { contains: options.q, mode: "insensitive" } }, { phone: { contains: options.q } }] } : {}),
    },
    orderBy: { name: "asc" },
    include: { purchases: { select: { dueAmount: true } } },
  });
  return suppliers.map((s) => ({
    id: s.id,
    name: s.name,
    phone: s.phone,
    address: s.address,
    notes: s.notes,
    isActive: s.isActive,
    purchaseCount: s.purchases.length,
    totalDue: fromPaisa(s.purchases.reduce((sum, p) => sum + toPaisa(p.dueAmount), 0)),
  }));
}

export type PurchaseQuery = { q?: string; supplierId?: string; dueOnly?: boolean; from?: Date; to?: Date; page: number; pageSize: number };

export async function listPurchases(query: PurchaseQuery): Promise<{ items: PurchaseListItem[]; total: number }> {
  const and: Prisma.PurchaseWhereInput[] = [];
  if (query.supplierId) and.push({ supplierId: query.supplierId });
  if (query.dueOnly) and.push({ dueAmount: { gt: 0 } });
  if (query.from) and.push({ purchaseDate: { gte: query.from } });
  if (query.to) and.push({ purchaseDate: { lt: query.to } });
  if (query.q) {
    and.push({
      OR: [
        { invoiceNo: { contains: query.q, mode: "insensitive" } },
        { supplier: { name: { contains: query.q, mode: "insensitive" } } },
        { items: { some: { variant: { sku: { contains: query.q, mode: "insensitive" } } } } },
      ],
    });
  }
  const where: Prisma.PurchaseWhereInput = { AND: and };

  const [total, purchases] = await Promise.all([
    prisma.purchase.count({ where }),
    prisma.purchase.findMany({
      where,
      orderBy: [{ purchaseDate: "desc" }, { createdAt: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { supplier: { select: { name: true } }, createdBy: { select: { name: true } }, items: { select: { qty: true } } },
    }),
  ]);

  return {
    total,
    items: purchases.map((p) => ({
      id: p.id,
      purchaseDate: p.purchaseDate.toISOString(),
      invoiceNo: p.invoiceNo,
      supplierName: p.supplier.name,
      itemCount: p.items.length,
      totalQty: p.items.reduce((sum, i) => sum + i.qty, 0),
      totalCost: p.totalCost.toString(),
      amountPaid: p.amountPaid.toString(),
      dueAmount: p.dueAmount.toString(),
      createdByName: p.createdBy?.name ?? null,
    })),
  };
}

export async function getPurchaseDetail(id: string): Promise<PurchaseDetail | null> {
  const p = await prisma.purchase.findUnique({
    where: { id },
    include: {
      supplier: { select: { id: true, name: true, phone: true } },
      createdBy: { select: { name: true } },
      items: {
        orderBy: { createdAt: "asc" },
        include: { variant: { include: { product: { select: { name: true } }, size: true, color: true } } },
      },
    },
  });
  if (!p) return null;

  return {
    id: p.id,
    purchaseDate: p.purchaseDate.toISOString(),
    invoiceNo: p.invoiceNo,
    allocationMethod: p.allocationMethod,
    supplier: p.supplier,
    itemsSubtotal: p.itemsSubtotal.toString(),
    transportCost: p.transportCost.toString(),
    otherCost: p.otherCost.toString(),
    totalCost: p.totalCost.toString(),
    amountPaid: p.amountPaid.toString(),
    dueAmount: p.dueAmount.toString(),
    note: p.note,
    createdByName: p.createdBy?.name ?? null,
    createdAt: p.createdAt.toISOString(),
    items: p.items.map((i) => ({
      id: i.id,
      variantId: i.variantId,
      productName: i.variant.product.name,
      sku: i.variant.sku,
      sizeName: i.variant.size.name,
      colorName: i.variant.color.name,
      colorHex: i.variant.color.hexCode,
      qty: i.qty,
      unitCost: i.unitCost.toString(),
      lineCost: i.lineCost.toString(),
      allocatedCost: i.allocatedCost.toString(),
      landedUnitCost: i.landedUnitCost.toString(),
      stockBefore: i.stockBefore,
      wacBefore: i.wacBefore.toString(),
      wacAfter: i.wacAfter.toString(),
    })),
  };
}
