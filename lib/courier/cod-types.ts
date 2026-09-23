// Client-side shapes of the /api/courier/cod and /api/courier/statements JSON.

import type { OrderStatusValue } from "@/lib/orders/constants";

export type StatementLineStatusValue = "PENDING" | "MATCHED" | "MISMATCH" | "UNMATCHED" | "ACCEPTED" | "DISPUTED";

export const STATEMENT_LINE_STATUS_LABELS: Record<StatementLineStatusValue, string> = {
  PENDING: "Pending",
  MATCHED: "Matched",
  MISMATCH: "Mismatch",
  UNMATCHED: "Not ours?",
  ACCEPTED: "Accepted",
  DISPUTED: "Disputed",
};

export const STATEMENT_SOURCE_LABELS = { STEADFAST_API: "Steadfast payout", CSV_IMPORT: "CSV import", MANUAL: "Manual entry" } as const;

export type CodSummary = {
  awaitingCount: number;
  awaitingCod: string;
  openDiscrepancies: number;
  collectedThisMonth: string;
  lastPayoutsSyncAt: string | null;
  steadfastEnabled: boolean;
};

export type AwaitingPayoutRow = {
  shipmentId: string;
  orderId: string;
  orderNo: string;
  orderStatus: OrderStatusValue;
  customerName: string;
  courierName: string;
  consignmentId: string | null;
  codCollected: string;
  deliveryCharge: string;
  chargeKnown: boolean;
  codFee: string;
  expectedNet: string;
  deliveredAt: string;
  daysWaiting: number;
};

export type StatementRow = {
  id: string;
  courierName: string;
  source: keyof typeof STATEMENT_SOURCE_LABELS;
  reference: string;
  status: "PROCESSING" | "PAID";
  statementDate: string;
  grossAmount: string;
  deliveryCharge: string;
  codCharge: string;
  netAmount: string;
  wallet: string | null;
  identityHolds: boolean;
  lineCount: number;
  settledCount: number;
  openCount: number;
  reconciledAt: string | null;
};

export type StatementLineView = {
  id: string;
  lineNo: number;
  statementId: string;
  statementReference: string;
  courierName: string;
  consignmentId: string | null;
  invoice: string | null;
  codAmount: string;
  deliveryCharge: string | null;
  orderId: string | null;
  orderNo: string | null;
  orderStatus: OrderStatusValue | null;
  status: StatementLineStatusValue;
  ourCod: string | null;
  expectedNet: string | null;
  paidNet: string | null;
  mismatchReason: string | null;
  settled: boolean;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolveNote: string | null;
};

export type StatementDetailView = StatementRow & {
  note: string | null;
  expectedNetSum: string | null;
  paidVsExpectedDiff: string | null;
  lines: StatementLineView[];
};
