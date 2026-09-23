import type { DeliveryZoneValue, OrderEditRequestStatusValue, OrderStatusValue, PaymentMethodValue } from "@/lib/orders/constants";

// Client-side shapes mirroring the JSON /api/orders/* returns.
// unitCostSnapshot is optional because stripCostFieldsForUser removes it
// entirely for roles without product.cost.view — never render assuming it
// exists (same convention as lib/catalog/types.ts).

export type OrderListItem = {
  id: string;
  orderNo: string;
  status: OrderStatusValue;
  channel: "ONLINE" | "WALK_IN";
  customer: { id: string; name: string; phone: string };
  total: string;
  dueAmount: string;
  createdBy: { id: string; name: string } | null;
  expectedDeliveryDate: string | null;
  createdAt: string;
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
};

export type PaymentView = {
  id: string;
  amount: string;
  method: PaymentMethodValue;
  wallet: string | null;
  transactionId: string | null;
  paidAt: string;
  receivedBy: { id: string; name: string } | null;
  verified: boolean;
  note: string | null;
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
  customer: OrderCustomer;
  courier: { id: string; name: string } | null;
  courierZoneId: string | null;
  deliveryZone: DeliveryZoneValue | null;
  deliveryCharge: string;
  expectedDeliveryDate: string | null;
  subtotal: string;
  discountTotal: string;
  total: string;
  dueAmount: string;
  internalNote: string | null;
  deliveryNote: string | null;
  items: OrderItemView[];
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
