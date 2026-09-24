import type { OrderChannelValue, OrderStatusValue, PaymentMethodValue } from "@/lib/orders/constants";

export const PAYMENT_LIST_VIEWS = ["unverified", "verified", "refunds", "all"] as const;
export type PaymentListView = (typeof PAYMENT_LIST_VIEWS)[number];

export const REFUND_STATUS_VALUES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type RefundStatusValue = (typeof REFUND_STATUS_VALUES)[number];

export const REFUND_STATUS_LABELS: Record<RefundStatusValue, string> = {
  PENDING: "Awaiting approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export type PaymentKindValue = "PAYMENT" | "REFUND" | "EXCHANGE_CREDIT";

export type PaymentListQuery = {
  view: PaymentListView;
  refundStatus?: RefundStatusValue;
  method?: PaymentMethodValue;
  walletId?: string;
  channel?: OrderChannelValue;
  from?: Date;
  to?: Date;
  q?: string;
  page: number;
  pageSize: number;
};

export type PaymentListItem = {
  id: string;
  kind: PaymentKindValue;
  amount: string;
  method: PaymentMethodValue;
  walletId: string | null;
  walletName: string | null;
  transactionId: string | null;
  paidAt: string;
  note: string | null;
  verified: boolean;
  verifiedAt: string | null;
  verifiedByName: string | null;
  receivedByName: string | null;
  refundReason: string | null;
  refundStatus: RefundStatusValue | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** A pending refund someone other than its requester is looking at. */
  canDecide: boolean;
  order: {
    id: string;
    orderNo: string;
    status: OrderStatusValue;
    channel: OrderChannelValue;
    total: string;
    dueAmount: string;
    /** Null for an anonymous walk-in sale. */
    customerName: string | null;
    customerPhone: string | null;
  };
};
