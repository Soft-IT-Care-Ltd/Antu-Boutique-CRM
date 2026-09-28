import "server-only";

import type { Prisma } from "@prisma/client";

import type { SessionUser } from "@/lib/auth/types";
import type { Db } from "@/lib/db/tx";
import { canActAt, getLocationAccess, getPackingHub } from "@/lib/locations/service";
import { createTransfer, TransferError } from "@/lib/transfers/service";

// C4 — CORRECTIONS.md item 3, "Needed at the packing hub" (feeds item 13).
//
// Online orders are packed at the hub, so every unit must be there first.
// For each variant, the hub's supply — what it holds plus what is already
// coming to it (transfers In transit, and Drafts raised for it) — is given
// to the confirmed, unpacked online orders OLDEST FIRST, so two orders
// never count the same last piece. What an order doesn't get is its
// shortfall. Each other location's stock of that variant is then offered,
// again oldest first, against those shortfalls: that is the location's
// "Needed at the packing hub" list. Once a transfer for it is drafted or
// received, the supply grows and the order drops off every list by itself.

export type HubNeedRow = {
  orderId: string;
  orderNo: string;
  orderCreatedAt: string;
  customerName: string | null;
  variantId: string;
  sku: string;
  productName: string;
  sizeName: string;
  colorName: string;
  colorHex: string;
  thumbPath: string | null;
  /** Units of this line the hub can't cover. */
  shortAtHub: number;
  /** Of those, how many this location holds for this order (oldest order first). */
  qtyHere: number;
};

export type HubNeedsLocation = { id: string; name: string; rows: number; units: number };

export type HubNeeds = {
  hub: { id: string; name: string };
  /** Every non-hub location that could help, with how much it's asked for. */
  locations: HubNeedsLocation[];
  /** Rows for the one location asked about. */
  rows: HubNeedRow[];
};

/** Orders the hub has to pack: confirmed, online, not deleted — the only status that holds a reservation and hasn't left the hub. */
const WAITING_ORDERS = { status: "CONFIRMED", channel: "ONLINE", deletedAt: null } satisfies Prisma.OrderWhereInput;

type Shortfall = { orderId: string; variantId: string; short: number; orderIdx: number };
type StockAt = { variantId: string; locationId: string; qty: number };

async function computeShortfalls(db: Db, hubId: string) {
  const orders = await db.order.findMany({
    where: WAITING_ORDERS,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, orderNo: true, createdAt: true, customer: { select: { name: true } }, items: { select: { variantId: true, qty: true } } },
  });
  const variantIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.variantId)))];
  if (variantIds.length === 0) return { orders, shortfalls: [] as Shortfall[], stock: [] as StockAt[] };

  const [onHand, open] = await Promise.all([
    db.variantStock.findMany({ where: { variantId: { in: variantIds } }, select: { variantId: true, locationId: true, qty: true } }),
    db.stockTransferLine.findMany({
      where: { variantId: { in: variantIds }, transfer: { status: { in: ["DRAFT", "IN_TRANSIT"] } } },
      select: { variantId: true, qtyRequested: true, qtySent: true, transfer: { select: { status: true, fromLocationId: true, toLocationId: true } } },
    }),
  ]);

  // A Draft is counted at whichever is larger — what was asked for or what
  // is already scanned. It is still on the sender's shelf, but promised:
  // the sender can't offer it again. (In transit has already left.)
  const stock: StockAt[] = onHand.map((s) => ({ ...s }));
  const planned = (l: (typeof open)[number]) => (l.transfer.status === "DRAFT" ? Math.max(l.qtyRequested, l.qtySent) : l.qtySent);
  for (const l of open) {
    if (l.transfer.status !== "DRAFT") continue;
    const at = stock.find((s) => s.variantId === l.variantId && s.locationId === l.transfer.fromLocationId);
    if (at) at.qty -= planned(l);
  }
  const supply = new Map<string, number>();
  for (const s of stock) if (s.locationId === hubId) supply.set(s.variantId, Math.max(0, s.qty));
  for (const l of open) if (l.transfer.toLocationId === hubId) supply.set(l.variantId, (supply.get(l.variantId) ?? 0) + planned(l));

  const shortfalls: Shortfall[] = [];
  orders.forEach((order, orderIdx) => {
    const need = new Map<string, number>();
    for (const i of order.items) need.set(i.variantId, (need.get(i.variantId) ?? 0) + i.qty);
    for (const [variantId, qty] of need) {
      const have = supply.get(variantId) ?? 0;
      const take = Math.min(have, qty);
      supply.set(variantId, have - take);
      if (qty > take) shortfalls.push({ orderId: order.id, variantId, short: qty - take, orderIdx });
    }
  });
  return { orders, shortfalls, stock };
}

/** Gives one location's stock to the shortfalls, oldest order first. */
function allocateAt(locationId: string, shortfalls: Shortfall[], stock: StockAt[]) {
  const left = new Map(stock.filter((s) => s.locationId === locationId && s.qty > 0).map((s) => [s.variantId, s.qty]));
  const out: (Shortfall & { here: number })[] = [];
  for (const s of shortfalls) {
    const have = left.get(s.variantId) ?? 0;
    if (have <= 0) continue;
    const here = Math.min(have, s.short);
    left.set(s.variantId, have - here);
    out.push({ ...s, here });
  }
  return out;
}

export async function getHubNeeds(db: Db, locationId: string | null): Promise<HubNeeds> {
  const hub = await getPackingHub(db);
  const [{ orders, shortfalls, stock }, locations] = await Promise.all([
    computeShortfalls(db, hub.id),
    db.location.findMany({ where: { isActive: true, isPackingHub: false }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true } }),
  ]);

  const summary = locations.map((l) => {
    const a = allocateAt(l.id, shortfalls, stock);
    return { id: l.id, name: l.name, rows: a.length, units: a.reduce((sum, r) => sum + r.here, 0) };
  });

  let rows: HubNeedRow[] = [];
  if (locationId && locationId !== hub.id) {
    const allocated = allocateAt(locationId, shortfalls, stock);
    const variants = await db.productVariant.findMany({
      where: { id: { in: [...new Set(allocated.map((a) => a.variantId))] } },
      select: { id: true, sku: true, size: { select: { name: true } }, color: { select: { name: true, hexCode: true } }, product: { select: { name: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { thumbPath: true } } } } },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));
    rows = allocated.map((a) => {
      const o = orders[a.orderIdx];
      const v = byId.get(a.variantId)!;
      return {
        orderId: o.id,
        orderNo: o.orderNo,
        orderCreatedAt: o.createdAt.toISOString(),
        customerName: o.customer?.name ?? null,
        variantId: v.id,
        sku: v.sku,
        productName: v.product.name,
        sizeName: v.size.name,
        colorName: v.color.name,
        colorHex: v.color.hexCode,
        thumbPath: v.product.images[0]?.thumbPath ?? null,
        shortAtHub: a.short,
        qtyHere: a.here,
      };
    });
  }
  return { hub, locations: summary, rows };
}

/**
 * The manager's ticks → one Draft transfer to the hub, pre-filled and
 * linked to those orders. Every pick is re-checked against what the list
 * says right now — a stale screen or a crafted request can't ask for more
 * than this location holds for that order.
 */
export async function createHubTransfer(
  tx: Prisma.TransactionClient,
  user: SessionUser,
  input: { fromLocationId: string; picks: { orderId: string; variantId: string; qty: number }[]; note?: string | null },
): Promise<{ id: string; transferNo: string }> {
  if (input.picks.length === 0) throw new TransferError("Tick at least one item.");
  if (!canActAt(await getLocationAccess(tx, user), input.fromLocationId)) throw new TransferError("You don't act for that location.", 403);
  // Serialises two managers raising transfers for the same hub at once:
  // the second sees the first's Draft as incoming supply.
  const hub = await getPackingHub(tx);
  await tx.$queryRaw`SELECT "id" FROM "locations" WHERE "id" = ${hub.id} FOR UPDATE`;

  const { shortfalls, stock } = await computeShortfalls(tx, hub.id);
  const allowed = new Map(allocateAt(input.fromLocationId, shortfalls, stock).map((a) => [`${a.orderId}:${a.variantId}`, a.here]));
  const lines = new Map<string, number>();
  const seen = new Set<string>();
  for (const p of input.picks) {
    const key = `${p.orderId}:${p.variantId}`;
    if (seen.has(key)) throw new TransferError("The same item is ticked twice for one order.");
    seen.add(key);
    const max = allowed.get(key) ?? 0;
    if (p.qty < 1 || p.qty > max) throw new TransferError(max === 0 ? "One of the ticked items is no longer needed from here — refresh the list." : `One of the ticked items needs at most ${max} from here — refresh the list.`, 409);
    lines.set(p.variantId, (lines.get(p.variantId) ?? 0) + p.qty);
  }
  return createTransfer(tx, user, {
    fromLocationId: input.fromLocationId,
    toLocationId: hub.id,
    note: input.note ?? "For orders waiting at the packing hub",
    lines: [...lines].map(([variantId, qtyRequested]) => ({ variantId, qtyRequested })),
    orderIds: [...new Set(input.picks.map((p) => p.orderId))],
  });
}
