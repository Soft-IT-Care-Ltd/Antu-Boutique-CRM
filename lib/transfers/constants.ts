// C4 (CORRECTIONS.md item 3) — client-safe transfer labels and shapes.

import type { PermissionKey } from "@/lib/auth/permission-definitions";

/** Who sees the transfer screens at all (each action then checks its own permission and location). */
export const TRANSFER_VIEW_PERMISSIONS: PermissionKey[] = ["transfer.send", "transfer.receive", "transfer.resolve"];

export const TRANSFER_STATUSES = ["DRAFT", "IN_TRANSIT", "RECEIVED", "RECEIVED_WITH_DIFFERENCE", "CANCELLED"] as const;
export type TransferStatusValue = (typeof TRANSFER_STATUSES)[number];

export const TRANSFER_STATUS_LABELS: Record<TransferStatusValue, string> = {
  DRAFT: "Draft",
  IN_TRANSIT: "In transit",
  RECEIVED: "Received",
  RECEIVED_WITH_DIFFERENCE: "Received with difference",
  CANCELLED: "Cancelled",
};

/** The list's tabs. "open" = everything someone still has to act on. */
export const TRANSFER_TABS = ["open", "incoming", "outgoing", "difference", "done", "all"] as const;
export type TransferTab = (typeof TRANSFER_TABS)[number];

export const TRANSFER_TAB_LABELS: Record<TransferTab, string> = {
  open: "Open",
  incoming: "Incoming",
  outgoing: "Outgoing",
  difference: "Missing in transit",
  done: "Done",
  all: "All",
};

/** One item on a transfer as the screens show it. No cost unless the viewer has product.cost.view. */
export type TransferLineView = {
  variantId: string;
  sku: string;
  productName: string;
  sizeName: string;
  colorName: string;
  colorHex: string;
  thumbPath: string | null;
  qtyRequested: number;
  qtySent: number;
  qtyScannedIn: number;
  qtyReceived: number;
  qtyFound: number;
  qtyWrittenOff: number;
  /** Sent but neither received, found nor written off — still "missing in transit". */
  missing: number;
  /** The source location's stock of it now (while a Draft) — to warn before sending more than is there. */
  atSource: number | null;
  unitCost?: string;
};

export type TransferView = {
  id: string;
  transferNo: string;
  status: TransferStatusValue;
  from: { id: string; name: string };
  to: { id: string; name: string; isPackingHub: boolean };
  note: string | null;
  createdByName: string | null;
  createdAt: string;
  sentByName: string | null;
  sentAt: string | null;
  receivedByName: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  orders: { id: string; orderNo: string }[];
  lines: TransferLineView[];
  totals: { requested: number; sent: number; scannedIn: number; received: number; found: number; writtenOff: number; missing: number };
  /** What this viewer may do right now. */
  can: { editSend: boolean; send: boolean; cancel: boolean; receive: boolean; resolve: boolean };
};

export type TransferListItem = {
  id: string;
  transferNo: string;
  status: TransferStatusValue;
  fromName: string;
  toName: string;
  units: number;
  missing: number;
  orderCount: number;
  createdByName: string | null;
  createdAt: string;
  sentAt: string | null;
  receivedAt: string | null;
};
