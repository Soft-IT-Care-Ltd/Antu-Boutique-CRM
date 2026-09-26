// PRD §4.18 — the trash. Pure rules only (no DB), shared by the service,
// the Trash screen and the order page, and unit-tested on their own.
//
// Deleted orders, customers, products (and leads, whose delete dialog has
// promised the same since P4.1) sit in the trash for 30 days, restorable,
// then the nightly purge (lib/trash/purge.ts) removes them. The purge never
// breaks history: a record that sales, stock movements or money still point
// to is archived instead of deleted — it leaves the trash for good but the
// row stays, so the ledger, wallets and past reports never move.

import type { OrderStatusValue } from "@/lib/orders/constants";

export const TRASH_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

export const TRASH_KINDS = ["order", "customer", "product", "lead"] as const;
export type TrashKind = (typeof TRASH_KINDS)[number];

export const TRASH_KIND_LABELS: Record<TrashKind, { one: string; many: string }> = {
  order: { one: "order", many: "Orders" },
  customer: { one: "customer", many: "Customers" },
  product: { one: "product", many: "Products" },
  lead: { one: "lead", many: "Leads" },
};

/** Anything deleted before this instant is due for the purge. */
export function purgeCutoff(now: Date): Date {
  return new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS);
}

/** When the purge will take a record deleted at `deletedAt`. */
export function purgeDueAt(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + TRASH_RETENTION_DAYS * DAY_MS);
}

/** Whole days left to restore it (0 = goes with tonight's purge). */
export function daysLeftInTrash(deletedAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((purgeDueAt(deletedAt).getTime() - now.getTime()) / DAY_MS));
}

// ─── Which orders may go to the trash ────────────────────────────────────
//
// Only an order that never touched money, stock or the courier: a LEAD
// that was never confirmed, or one CANCELLED before packing. Anything
// further along is business history (reservations, the ledger, wallets,
// COD, profit) — it is cancelled or returned, never deleted. Checked again
// by the purge, so an order that somehow gained history is left alone.

export const TRASHABLE_ORDER_STATUSES: readonly OrderStatusValue[] = ["LEAD", "CANCELLED"];

export type OrderHistoryCounts = {
  status: OrderStatusValue;
  /** Converted from a lead: it stays as that lead's order (a converted lead is final). */
  leadId: string | null;
  exchangedFromOrderId: string | null;
  payments: number;
  stockMovements: number;
  shipment: boolean;
  returnCases: number;
  returnInspections: number;
  storeCreditEntries: number;
  statementLines: number;
  packagingExpense: boolean;
  exchangeOrders: number;
  replacementFor: boolean;
};

/** Why this order can't go to the trash, or null when it can. */
export function orderTrashBlock(h: OrderHistoryCounts): string | null {
  if (!TRASHABLE_ORDER_STATUSES.includes(h.status)) {
    return "Only an order that was never confirmed, or was cancelled before packing, can be deleted. Cancel or return this one instead.";
  }
  if (h.payments > 0) return "Money has been recorded on this order, so it stays on record. Cancel it instead.";
  if (h.stockMovements > 0 || h.packagingExpense) return "Stock has moved for this order, so it stays on record.";
  if (h.shipment || h.statementLines > 0 || h.returnInspections > 0) return "This order has been with the courier, so it stays on record.";
  if (h.returnCases > 0 || h.exchangeOrders > 0 || h.replacementFor || h.exchangedFromOrderId) return "This order is part of a return or exchange, so it stays on record.";
  if (h.storeCreditEntries > 0) return "Store credit was issued or spent on this order, so it stays on record.";
  if (h.leadId) return "This order was placed from a lead and stays as that lead's order. Cancel it instead.";
  return null;
}

// ─── What the purge does with a customer or product ──────────────────────

export type PurgeDecision = "delete" | "archive" | "defer";

/**
 * `history` = rows outside the trash that point here (orders, leads, store
 * credit; sales, stock movements, purchases, sets). `trashedRefs` = rows
 * that point here but are themselves still in the trash, waiting for their
 * own purge. History always wins (archive). Otherwise wait for the trashed
 * rows to go first — they may yet be restored — then delete.
 */
export function purgeDecision(history: number, trashedRefs: number): PurgeDecision {
  if (history > 0) return "archive";
  if (trashedRefs > 0) return "defer";
  return "delete";
}
