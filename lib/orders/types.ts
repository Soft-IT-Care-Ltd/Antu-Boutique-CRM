import type { FulfilmentStatusValue, LineFulfilment } from "@/lib/fulfilment/constants";
import type { DeliveryZoneValue, OrderEditRequestStatusValue, OrderStatusValue, PaymentMethodValue } from "@/lib/orders/constants";
import type { LeadSourceValue } from "@/lib/leads/constants";
import type { OrderSetLineView } from "@/lib/sets/types";

// Client-side shapes mirroring the JSON /api/orders/* returns.
// unitCostSnapshot is optional because stripCostFieldsForUser removes it
// entirely for roles without product.cost.view — never render assuming it
// exists (same convention as lib/catalog/types.ts).

export type OrderListItem = {
  id: string;
  orderNo: string;
  status: OrderStatusValue;
  channel: "ONLINE" | "WALK_IN";
  /** Null only for an anonymous walk-in (POS) sale. */
  customer: { id: string; name: string; phone: string } | null;
  total: string;
  dueAmount: string;
  createdBy: { id: string; name: string } | null;
  expectedDeliveryDate: string | null;
  createdAt: string;
  /** C5 — confirmed online orders only. */
  fulfilmentStatus: FulfilmentStatusValue | null;
};

export type OrderImageView = {
  id: string;
  orderItemId: string | null;
  filePath: string;
  thumbPath: string;
  caption: string | null;
  uploadedAt: string;
};

export type OrderItemView = {
  id: string;
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  sizeName: string;
  colorName: string;
  colorHex: string;
  qty: number;
  unitPrice: string;
  lineDiscount: string;
  lineTotal: string;
  unitCostSnapshot?: string | null;
  stockOverride: boolean;
  stockOverrideReason: string | null;
  returnedQty: number;
  /** P3.3 — the outfit set this line is a component of, if any. */
  setLineId: string | null;
  /** C5 — where its units come from, while the order is confirmed (null otherwise). */
  fulfilment: LineFulfilment | null;
};

export type PaymentView = {
  id: string;
  /** REFUND rows are negative; EXCHANGE_CREDIT is negative on the original order, positive on its replacement; STORE_CREDIT is positive where spent, negative where issued or given back. */
  amount: string;
  method: PaymentMethodValue;
  kind: "PAYMENT" | "REFUND" | "EXCHANGE_CREDIT" | "STORE_CREDIT";
  walletId: string | null;
  walletName: string | null;
  transactionId: string | null;
  paidAt: string;
  receivedBy: { id: string; name: string } | null;
  verified: boolean;
  verifiedBy: { id: string; name: string } | null;
  verifiedAt: string | null;
  note: string | null;
  refundReason: string | null;
  refundStatus: "PENDING" | "APPROVED" | "REJECTED" | null;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** Settled from a courier statement — locked on this panel (P2.2b). */
  fromCourierStatement: boolean;
};

export type OrderStatusHistoryEntry = {
  id: string;
  fromStatus: OrderStatusValue | null;
  toStatus: OrderStatusValue;
  note: string | null;
  changedBy: { id: string; name: string } | null;
  createdAt: string;
};

export type InvoiceView = {
  id: string;
  version: number;
  filePath: string;
  createdAt: string;
};

export type OrderEditRequestView = {
  id: string;
  status: OrderEditRequestStatusValue;
  proposedChanges: unknown;
  requestedBy: { id: string; name: string } | null;
  reviewedBy: { id: string; name: string } | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
};

export type OrderCustomer = {
  id: string;
  name: string;
  phone: string;
  altPhone: string | null;
  division: string | null;
  district: string | null;
  thana: string | null;
  addressDetail: string | null;
};

export type OrderDetail = {
  id: string;
  orderNo: string;
  status: OrderStatusValue;
  channel: "ONLINE" | "WALK_IN";
  /** Null only for an anonymous walk-in (POS) sale — every ONLINE order has one (DB CHECK). */
  customer: OrderCustomer | null;
  courier: { id: string; name: string } | null;
  courierZoneId: string | null;
  deliveryZone: DeliveryZoneValue | null;
  deliveryCharge: string;
  expectedDeliveryDate: string | null;
  /** P3.2 — set on an exchange's replacement order (its items come from the exchange). */
  exchangedFromOrderId: string | null;
  /** P4.1 — the lead this order converted (PRD §4.5), if it came from one. */
  lead: { id: string; name: string; source: LeadSourceValue } | null;
  subtotal: string;
  discountTotal: string;
  total: string;
  dueAmount: string;
  internalNote: string | null;
  deliveryNote: string | null;
  /** C5 — automatic fulfilment status (confirmed online orders), days waiting and the "Wait" date. */
  fulfilmentStatus: FulfilmentStatusValue | null;
  waitingSince: string | null;
  stockExpectedOn: string | null;
  items: OrderItemView[];
  /** P3.3 — outfit sets on the order; their components are in `items`. */
  setLines: OrderSetLineView[];
  images: OrderImageView[];
  payments: PaymentView[];
  statusHistory: OrderStatusHistoryEntry[];
  invoices: InvoiceView[];
  editRequests: OrderEditRequestView[];
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
};

export type CourierZoneOption = {
  id: string;
  zone: DeliveryZoneValue;
  charge: string;
};

export type CourierCompanyOption = {
  id: string;
  name: string;
  zones: CourierZoneOption[];
};

export type ProductSearchVariant = {
  id: string;
  sku: string;
  sizeName: string;
  colorName: string;
  colorHex: string;
  effectivePrice: string;
  available: number;
  isActive: boolean;
  weightedAvgCost?: string;
};

export type ProductSearchResult = {
  id: string;
  code: string;
  name: string;
  thumbPath: string | null;
  variants: ProductSearchVariant[];
};

export function orderUploadUrl(relativePath: string): string {
  return `/uploads/${relativePath}`;
}
