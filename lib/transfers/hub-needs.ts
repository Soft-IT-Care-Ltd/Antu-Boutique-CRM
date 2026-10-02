import "server-only";

import type { Prisma } from "@prisma/client";

import type { SessionUser } from "@/lib/auth/types";
import type { Db } from "@/lib/db/tx";
import { canActAt, getLocationAccess, getPackingHub } from "@/lib/locations/service";
import { computeAllocation, type LineAllocation } from "@/lib/fulfilment/allocation";
import { createTransfer, TransferError } from "@/lib/transfers/service";

// C4 — CORRECTIONS.md item 3, "Needed at the packing hub" (feeds item 13).
//
// Online orders are packed at the hub, so every unit must be there first.
// C5: the rows come from THE allocation (lib/fulfilment/allocation.ts) —
// the same one that gives every order its fulfilment status — so this list
// and an order's "Needs transfer" can never disagree. Oldest order first,
// each line takes the hub's stock, then what is already coming to the hub
// (transfers In transit, and Drafts raised for it), then the other
// locations' stock in their Settings order. A location's list is exactly
// the units the allocation gave to orders from that location — a shortfall
// is offered by one location only, never twice. Once a transfer for it is
// drafted or received, the supply moves and the order drops off by itself.

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

/** One location's share of the allocation: per (order, variant), how many units it sends. */
function fromLocation(lines: LineAllocation[], locationId: string) {
  const out = new Map<string, { orderId: string; variantId: string; short: number; here: number }>();
  for (const l of lines) {
    const here = l.fromLocations.find((f) => f.locationId === locationId)?.qty ?? 0;
    if (here <= 0) continue;
    const k = `${l.orderId}:${l.variantId}`;
    const row = out.get(k) ?? { orderId: l.orderId, variantId: l.variantId, short: 0, here: 0 };
    row.short += l.qty - l.atHub - l.incoming;
    row.here += here;
    out.set(k, row);
  }
  return [...out.values()];
}

export async function getHubNeeds(db: Db, locationId: string | null): Promise<HubNeeds> {
  const hub = await getPackingHub(db);
  const allocation = await computeAllocation(db as Prisma.TransactionClient);

  const summary = allocation.locations.map((l) => {
    const a = fromLocation(allocation.lines, l.id);
    return { id: l.id, name: l.name, rows: a.length, units: a.reduce((sum, r) => sum + r.here, 0) };
  });

  let rows: HubNeedRow[] = [];
  if (locationId && locationId !== hub.id) {
    const allocated = fromLocation(allocation.lines, locationId);
    const [variants, orders] = await Promise.all([
      db.productVariant.findMany({
        where: { id: { in: [...new Set(allocated.map((a) => a.variantId))] } },
        select: { id: true, sku: true, size: { select: { name: true } }, color: { select: { name: true, hexCode: true } }, product: { select: { name: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { thumbPath: true } } } } },
      }),
      db.order.findMany({ where: { id: { in: [...new Set(allocated.map((a) => a.orderId))] } }, select: { id: true, orderNo: true, createdAt: true, customer: { select: { name: true } } } }),
    ]);
    const byId = new Map(variants.map((v) => [v.id, v]));
    const orderById = new Map(orders.map((o) => [o.id, o]));
    rows = allocated.map((a) => {
      const o = orderById.get(a.orderId)!;
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

  const allowed = new Map(fromLocation((await computeAllocation(tx)).lines, input.fromLocationId).map((a) => [`${a.orderId}:${a.variantId}`, a.here]));
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
