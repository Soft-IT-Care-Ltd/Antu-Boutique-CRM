// Client-facing inventory shapes. Every cost-bearing field is optional:
// the API strips it (CLAUDE.md rule 5) for callers without product.cost.view,
// so the UI must treat its absence as "not allowed to see", not as zero.

import type { StockMovementTypeValue, VariantStockStatus } from "./constants";
import type { ProductRollUp } from "./low-stock";

export type StockReportRow = {
  variantId: string;
  productId: string;
  productName: string;
  productCode: string;
  categoryName: string | null;
  sku: string;
  sizeName: string;
  colorName: string;
  colorHex: string;
  isActive: boolean;
  stockQty: number;
  reservedQty: number;
  available: number;
  threshold: number;
  status: VariantStockStatus;
  weightedAvgCost?: string;
  valueAtCost?: string;
};

export type StockReportTotals = {
  variants: number;
  onHand: number;
  reserved: number;
  available: number;
  valueAtCost?: string;
};

export type LowStockProductAlert = ProductRollUp & {
  productId: string;
  productName: string;
  productCode: string;
  categoryName: string | null;
  totalVariants: number;
};

export type StockMovementRow = {
  id: string;
  createdAt: string;
  type: StockMovementTypeValue;
  qty: number;
  stockAfter: number;
  unitCostSnapshot?: string;
  referenceType: string;
  referenceId: string | null;
  /** Human label for the reference: an order number, a supplier invoice, … */
  referenceLabel: string | null;
  /** In-app link to the referenced record, when there is a screen for it. */
  referenceHref: string | null;
  note: string | null;
  actorName: string | null;
  variant: { id: string; sku: string; productName: string; sizeName: string; colorName: string; colorHex: string };
};

export type SupplierItem = {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  purchaseCount: number;
  totalDue: string;
};

export type PurchaseListItem = {
  id: string;
  purchaseDate: string;
  invoiceNo: string | null;
  supplierName: string;
  itemCount: number;
  totalQty: number;
  totalCost: string;
  amountPaid: string;
  dueAmount: string;
  createdByName: string | null;
};

export type PurchaseDetailItem = {
  id: string;
  variantId: string;
  productName: string;
  sku: string;
  sizeName: string;
  colorName: string;
  colorHex: string;
  qty: number;
  unitCost: string;
  lineCost: string;
  allocatedCost: string;
  landedUnitCost: string;
  stockBefore: number;
  wacBefore: string;
  wacAfter: string;
};

export type PurchaseDetail = {
  id: string;
  purchaseDate: string;
  invoiceNo: string | null;
  allocationMethod: "BY_VALUE" | "BY_QTY";
  supplier: { id: string; name: string; phone: string | null };
  itemsSubtotal: string;
  transportCost: string;
  otherCost: string;
  totalCost: string;
  amountPaid: string;
  dueAmount: string;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
  items: PurchaseDetailItem[];
};

export type InventoryNavLink = { href: string; label: string };
