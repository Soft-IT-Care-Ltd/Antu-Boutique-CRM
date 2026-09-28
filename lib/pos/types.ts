import type { OrderChannelValue } from "@/lib/orders/constants";
import type { Denominations, PosTenderMethod } from "@/lib/pos/constants";

// Client-side shapes mirroring what /api/pos/* returns. Money is "123.45".
// Nothing here carries cost — the POS screens show selling prices only.

export type DrawerFlowRow = {
  id: string;
  source: "PAYMENT" | "REFUND" | "EXPENSE" | "ENTRY" | "COURIER_PAYOUT";
  at: string;
  /** Positive = into the drawer, negative = out of it. */
  amount: string;
  label: string;
  orderId: string | null;
  orderNo: string | null;
  channel: OrderChannelValue | null;
  verified: boolean | null;
  note: string | null;
  /** Recorded after the drawer was closed — not in its frozen expected figure. */
  afterClose: boolean;
};

export type DrawerSummary = {
  id: string;
  walletId: string;
  walletName: string;
  businessDay: string;
  status: "OPEN" | "CLOSED";
  openedAt: string;
  openedByName: string | null;
  openingCount: string;
  openingDenominations: Denominations | null;
  openingNote: string | null;
  bookBalanceAtOpen: string;
  closedAt: string | null;
  closedByName: string | null;
  closingCount: string | null;
  closingDenominations: Denominations | null;
  closeNote: string | null;
  /** Live while open; frozen at close. */
  expectedClose: string;
  difference: string | null;
  overShortExpenseId: string | null;
  totals: {
    cashSales: string;
    cashSalesCount: number;
    otherCashIn: string;
    cashOut: string;
    /** Cash payments not yet verified — the close verifies them. */
    unverified: string;
    unverifiedCount: number;
  };
  rows: DrawerFlowRow[];
  /** The wallet's own (verified-only) balance right now, for the books-vs-drawer check. */
  walletBalanceNow: string;
};

export type DrawerState = {
  walletId: string;
  walletName: string;
  today: string;
  /** Today's drawer, or an older one still open (it must be closed first). */
  drawer: DrawerSummary | null;
  /** The last counted close — what today's opening count should normally match. */
  lastClosingCount: string | null;
  lastClosedDay: string | null;
};

export type DrawerHistoryItem = {
  id: string;
  businessDay: string;
  status: "OPEN" | "CLOSED";
  openingCount: string;
  expectedClose: string | null;
  closingCount: string | null;
  difference: string | null;
  openedByName: string | null;
  closedByName: string | null;
};

export type PosVariantHit = {
  variantId: string;
  productId: string;
  productName: string;
  productCode: string;
  sku: string;
  sizeName: string;
  colorName: string;
  colorHex: string;
  price: string;
  /** C3 — on hand at the POS's own showroom (may be negative). */
  available: number;
  thumbPath: string | null;
};

export type PosSaleResult = {
  orderId: string;
  orderNo: string;
  total: string;
  change: string;
  customerName: string | null;
};

export type PosRecentSale = {
  id: string;
  orderNo: string;
  total: string;
  createdAt: string;
  customerName: string | null;
  itemCount: number;
  methods: PosTenderMethod[];
  hasInvoice: boolean;
};
