import type { FulfilmentStatus, Prisma } from "@prisma/client";

// C5 — CORRECTIONS.md items 12 and 13: where every unit of every confirmed
// online order comes from. THE one allocation in the system: the order's
// fulfilment status (lib/fulfilment/settle.ts), the "Needed at the packing
// hub" screen and its transfers (lib/transfers/hub-needs.ts), packing's
// check (lib/orders/pack.ts) and the POS warning (lib/pos/lookup.ts) all
// read it, so they can never disagree about who gets the last piece.
//
// Per variant, orders oldest first (placed time, then id). Each line takes,
// in turn:
//   1. stock AT THE PACKING HUB (less what a Draft out of the hub promised away);
//   2. units already COMING to the hub — Drafts raised for it (at the larger
//      of requested and scanned) and transfers in transit to it;
//   3. stock at the OTHER locations, in their Settings order (less what
//      their own Drafts promised away);
//   4. what is left is a BACKORDER — not anywhere.
// Variants are independent of each other, so a stock movement only ever
// changes the allocation of its own variant.
//
// Deliberately free of "server-only" and of the prisma singleton (like
// lib/inventory/ledger.ts), so prisma/seed.ts settles its demo orders with it.

export type FulfilmentStatusValue = FulfilmentStatus;

/** The orders that hold units: confirmed, online, not in the trash. */
export const ALLOCATED_ORDERS = { status: "CONFIRMED", channel: "ONLINE", deletedAt: null } satisfies Prisma.OrderWhereInput;

export type AllocItem = { id: string; variantId: string; qty: number };
export type AllocOrder = { id: string; createdAt: Date; items: AllocItem[] };
export type AllocTransfer = { variantId: string; status: "DRAFT" | "IN_TRANSIT"; fromLocationId: string; toLocationId: string; qtyRequested: number; qtySent: number };

export type AllocInput = {
  hubId: string;
  /** Every other active location, in the order their stock is offered. */
  otherLocationIds: string[];
  orders: AllocOrder[];
  onHand: { variantId: string; locationId: string; qty: number }[];
  transfers: AllocTransfer[];
};

export type LineAllocation = {
  itemId: string;
  orderId: string;
  variantId: string;
  qty: number;
  atHub: number;
  incoming: number;
  fromLocations: { locationId: string; qty: number }[];
  backorder: number;
};

/** A Draft is counted at the larger of what was asked for and what is already scanned; in transit at what was sent. */
const planned = (t: AllocTransfer) => (t.status === "DRAFT" ? Math.max(t.qtyRequested, t.qtySent) : t.qtySent);

export const compareOrdersOldestFirst = (a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }) =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Pure: gives each variant's supply to the lines, oldest order first. */
export function allocate(input: AllocInput): LineAllocation[] {
  const key = (variantId: string, locationId: string) => `${variantId}|${locationId}`;
  const free = new Map<string, number>();
  for (const s of input.onHand) free.set(key(s.variantId, s.locationId), (free.get(key(s.variantId, s.locationId)) ?? 0) + s.qty);
  const incoming = new Map<string, number>();
  for (const t of input.transfers) {
    // A Draft's units still sit at the sender but are promised: nobody else may count them there.
    if (t.status === "DRAFT") free.set(key(t.variantId, t.fromLocationId), (free.get(key(t.variantId, t.fromLocationId)) ?? 0) - planned(t));
    if (t.toLocationId === input.hubId) incoming.set(t.variantId, (incoming.get(t.variantId) ?? 0) + planned(t));
  }
  const take = (map: Map<string, number>, k: string, want: number) => {
    const have = Math.max(0, map.get(k) ?? 0);
    const got = Math.min(have, want);
    if (got > 0) map.set(k, have - got);
    return got;
  };

  const out: LineAllocation[] = [];
  for (const order of [...input.orders].sort(compareOrdersOldestFirst)) {
    for (const item of order.items) {
      let need = item.qty;
      const atHub = take(free, key(item.variantId, input.hubId), need);
      need -= atHub;
      const inc = take(incoming, item.variantId, need);
      need -= inc;
      const fromLocations: { locationId: string; qty: number }[] = [];
      for (const locationId of input.otherLocationIds) {
        if (need === 0) break;
        const got = take(free, key(item.variantId, locationId), need);
        if (got > 0) fromLocations.push({ locationId, qty: got });
        need -= got;
      }
      out.push({ itemId: item.id, orderId: order.id, variantId: item.variantId, qty: item.qty, atHub, incoming: inc, fromLocations, backorder: need });
    }
  }
  return out;
}

export type LineSplit = { qty: number; atHubQty: number; incomingQty: number; transferQty: number; backorderQty: number };

/** An order's status from all of its lines: any unit nowhere → waiting; any not at the hub → needs transfer; else ready. */
export function fulfilmentStatusOf(lines: LineSplit[]): FulfilmentStatusValue {
  if (lines.some((l) => l.backorderQty > 0)) return "WAITING_FOR_STOCK";
  if (lines.some((l) => l.atHubQty < l.qty)) return "NEEDS_TRANSFER";
  return "READY_TO_PACK";
}

export const splitOf = (a: LineAllocation): LineSplit => ({
  qty: a.qty,
  atHubQty: a.atHub,
  incomingQty: a.incoming,
  transferQty: a.fromLocations.reduce((sum, f) => sum + f.qty, 0),
  backorderQty: a.backorder,
});

type Db = Prisma.TransactionClient;

export type ComputedAllocation = {
  hub: { id: string; name: string };
  locations: { id: string; name: string }[];
  /** Allocated orders that hold one of the variants asked about, oldest first. */
  orders: { id: string; orderNo: string; createdAt: Date }[];
  lines: LineAllocation[];
};

/**
 * Loads what the allocation needs and runs it — for the given variants
 * (with every confirmed online order holding them), or for everything.
 * Lines of other variants on those orders are not allocated here.
 */
export async function computeAllocation(db: Db, variantIds?: string[]): Promise<ComputedAllocation> {
  const [hub, locations] = await Promise.all([
    db.location.findFirst({ where: { isPackingHub: true }, select: { id: true, name: true } }),
    db.location.findMany({ where: { isActive: true, isPackingHub: false }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true } }),
  ]);
  if (!hub) return { hub: { id: "", name: "" }, locations, orders: [], lines: [] };
  const onlyVariants = variantIds ? { variantId: { in: variantIds } } : {};
  const orders = await db.order.findMany({
    where: { ...ALLOCATED_ORDERS, ...(variantIds ? { items: { some: onlyVariants } } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, orderNo: true, createdAt: true, items: { where: onlyVariants, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, variantId: true, qty: true } } },
  });
  const vIds = variantIds ?? [...new Set(orders.flatMap((o) => o.items.map((i) => i.variantId)))];
  if (vIds.length === 0) return { hub, locations, orders: [], lines: [] };
  const [onHand, transferLines] = await Promise.all([
    db.variantStock.findMany({ where: { variantId: { in: vIds } }, select: { variantId: true, locationId: true, qty: true } }),
    db.stockTransferLine.findMany({
      where: { variantId: { in: vIds }, transfer: { status: { in: ["DRAFT", "IN_TRANSIT"] } } },
      select: { variantId: true, qtyRequested: true, qtySent: true, transfer: { select: { status: true, fromLocationId: true, toLocationId: true } } },
    }),
  ]);
  const lines = allocate({
    hubId: hub.id,
    otherLocationIds: locations.map((l) => l.id),
    orders,
    onHand,
    transfers: transferLines.map((l) => ({
      variantId: l.variantId,
      status: l.transfer.status as "DRAFT" | "IN_TRANSIT",
      fromLocationId: l.transfer.fromLocationId,
      toLocationId: l.transfer.toLocationId,
      qtyRequested: l.qtyRequested,
      qtySent: l.qtySent,
    })),
  });
  return { hub, locations, orders: orders.map((o) => ({ id: o.id, orderNo: o.orderNo, createdAt: o.createdAt })), lines };
}
