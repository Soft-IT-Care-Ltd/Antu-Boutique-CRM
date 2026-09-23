// Client-side shapes of the /api/courier/* JSON. Cost fields
// (courierCost*) are optional because stripCostFieldsForUser removes them for
// roles without product.cost.view; COD fields are optional because they are
// only sent to callers who can see order money.

import type { ShipmentSubStatusValue, ReturnInspectionSourceValue, ReturnInspectionStatusValue } from "@/lib/courier/constants";
import type { DeliveryZoneValue, OrderStatusValue } from "@/lib/orders/constants";

export type ReadyToShipRow = {
  orderId: string;
  orderNo: string;
  customerName: string;
  phone: string;
  address: string;
  courierName: string | null;
  items: string[];
  bookingInProgress: boolean;
  codAmount?: string;
  packedSince: string;
};

export type ShipmentRow = {
  shipmentId: string;
  orderId: string;
  orderNo: string;
  orderStatus: OrderStatusValue;
  customerName: string;
  phone: string;
  courierName: string;
  consignmentId: string | null;
  trackingCode: string | null;
  trackingUrl: string | null;
  steadfastStatus: string | null;
  subStatus: ShipmentSubStatusValue | null;
  onHold: boolean;
  needsAttention: boolean;
  attentionReason: string | null;
  accountsReviewRequired: boolean;
  zone: DeliveryZoneValue | null;
  weightGrams: number | null;
  courierCostEstimate?: string | null;
  courierCostActual?: string | null;
  codAmount?: string;
  codCollected?: string | null;
  codReceivedAt?: string | null;
  bookedAt: string | null;
  deliveredAt: string | null;
  lastStatusAt: string | null;
  finalizedAt: string | null;
};

export type ShipmentDetailView = ShipmentRow & {
  bookedBy: string | null;
  trackingEvents: { id: string; message: string; eventAt: string; source: string }[];
};

export type CourierReturnRow = {
  id: string;
  source: ReturnInspectionSourceValue;
  status: ReturnInspectionStatusValue;
  orderId: string;
  orderNo: string;
  orderStatus: OrderStatusValue;
  customerName: string;
  phone: string;
  consignmentId: string | null;
  trackingUrl: string | null;
  createdAt: string;
  inspectedAt: string | null;
  inspectedBy: string | null;
  note: string | null;
  items: {
    orderItemId: string;
    productName: string;
    sku: string;
    sizeName: string;
    colorName: string;
    colorHex: string;
    orderedQty: number;
    expectedBackQty: number;
    goodQty: number;
    damagedQty: number;
  }[];
};

export type SendPreviewRowView = {
  orderId: string;
  orderNo: string;
  customerName: string;
  phone: string;
  normalizedPhone: string | null;
  address: string;
  deliveryNote: string | null;
  itemDescription: string;
  codAmount?: string;
  zone: DeliveryZoneValue | null;
  weightGrams: number | null;
  weightComplete: boolean;
  courierCostEstimate?: number | null;
  error: string | null;
};

export type SendResultRowView = {
  orderId: string;
  orderNo: string;
  ok: boolean;
  skipped?: boolean;
  consignmentId?: string;
  trackingCode?: string | null;
  error?: string;
};

export type CostRateView = { zone: DeliveryZoneValue; baseRate?: string; perKgRate?: string };
