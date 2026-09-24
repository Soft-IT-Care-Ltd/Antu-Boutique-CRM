// View types for PRD §4.11 screens. Client-safe. None of these carry cost,
// except ExchangeReport.totals.companyCourierCost, which the API strips for
// roles without product.cost.view (lib/auth/strip-cost-fields.ts).

import type { OrderChannelValue, OrderStatusValue } from "@/lib/orders/constants";
import type { CourierChargeBearerValue, ReturnCaseModeValue, ReturnCaseStatusValue, ReturnCaseTypeValue, ReturnReasonValue } from "@/lib/returns/constants";

export type VariantLabel = { sku: string; product: string; size: string; color: string; hexCode: string };

export type ReturnCaseView = {
  id: string;
  type: ReturnCaseTypeValue;
  mode: ReturnCaseModeValue;
  status: ReturnCaseStatusValue;
  reason: ReturnReasonValue;
  reasonNote: string | null;
  courierChargeBearer: CourierChargeBearerValue | null;
  order: { id: string; orderNo: string; status: OrderStatusValue; channel: OrderChannelValue; customerName: string; customerPhone: string | null; salesExecutive: string | null };
  replacementOrder: { id: string; orderNo: string; status: OrderStatusValue; dueAmount: string } | null;
  lines: {
    orderItemId: string;
    qty: number;
    /** What the customer paid per unit (selling price, not cost). */
    unitPrice: string;
    item: VariantLabel;
    replacement: VariantLabel | null;
    /** Set once the condition check is done. */
    goodQty: number | null;
    damagedQty: number | null;
  }[];
  itemChecked: boolean;
  checkedAt: string | null;
  requestedBy: string | null;
  requestedById: string | null;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelNote: string | null;
  completedAt: string | null;
  /** Refund requested by a counter exchange for a cheaper replacement (pending or approved). */
  refundRequested: string;
  isMine: boolean;
};

export type ReturnableItem = {
  orderItemId: string;
  variantId: string;
  productId: string;
  sku: string;
  product: string;
  size: string;
  color: string;
  hexCode: string;
  qty: number;
  returnedQty: number;
  unitPrice: string;
  /** Units that can still come back (not returned, not in a pending request). */
  returnable: number;
};

export type OrderReturnInfo = {
  /** The customer has the goods (delivered / completed / part-way through an exchange). */
  returnableStatus: boolean;
  /** An anonymous walk-in sale can only be exchanged at the counter. */
  hasCustomer: boolean;
  items: ReturnableItem[];
  cases: ReturnCaseView[];
  /** Set when this order is the replacement an exchange created. */
  exchangedFrom: {
    caseId: string;
    orderId: string;
    orderNo: string;
    reason: ReturnReasonValue;
    reasonNote: string | null;
    mode: ReturnCaseModeValue;
    status: ReturnCaseStatusValue;
  } | null;
};

export type CounterLookup = {
  orderId: string;
  orderNo: string;
  status: OrderStatusValue;
  channel: OrderChannelValue;
  soldAt: string;
  customerName: string;
  returnableStatus: boolean;
  items: ReturnableItem[];
};

export type ExchangeReport = {
  totals: { exchanges: number; returns: number; counter: number; companyBorne: number; companyCourierCost?: string };
  byReason: { reason: ReturnReasonValue; exchanges: number; returns: number; units: number }[];
  byProduct: { product: string; exchangedUnits: number; returnedUnits: number; variants: { sku: string; label: string; exchangedUnits: number; returnedUnits: number }[] }[];
  byStaff: { name: string; exchanges: number; returns: number; units: number }[];
};
