import { Prisma } from "@prisma/client";

import { loadEffectivePermissions } from "@/lib/auth/permissions";
import { withTx, type Db } from "@/lib/db/tx";
import { FULFILMENT_STATUS_LABELS } from "@/lib/fulfilment/constants";
import { ALLOCATED_ORDERS, computeAllocation, fulfilmentStatusOf, splitOf, type FulfilmentStatusValue, type LineSplit } from "@/lib/fulfilment/allocation";

// C5 — CORRECTIONS.md item 13: "recomputed on every stock movement".
//
// Database triggers (migration 20261007090000_fulfilment) queue a variant
// in `fulfilment_queue` whenever anything that feeds the allocation moves:
// its stock anywhere, its reservation, a transfer of it, an order line of
// it, an order holding it entering or leaving Confirmed, or the packing hub.
// settleFulfilment empties the queue: it re-runs the one allocation
// (lib/fulfilment/allocation.ts) for the queued variants, stores each
// line's split and each order's status, and tells people when an order's
// status changes. It is called at the end of every operation that brings
// stock in or takes it away (purchase, transfer, return, POS sale,
// adjustment, packing, order writes), inside that operation's transaction,
// and before anything reads the status (the orders list, the order page,
// the hub screen, the waiting list) — so a status is never read stale.
//
// Concurrency: the queue is read, not locked. Two settles at once compute
// from the same committed stock; an order's status is moved with a guarded
// UPDATE (… WHERE fulfilmentStatus = what was read), so only one of them
// records — and notifies — each change. A movement committed after the read
// queued its own row, which the next settle picks up.

type Tx = Prisma.TransactionClient;

export type FulfilmentTransition = {
  orderId: string;
  orderNo: string;
  from: FulfilmentStatusValue | null;
  to: FulfilmentStatusValue | null;
  createdById: string | null;
};

export type SettleOptions = {
  /** Why stock moved, for the notification ("Sold at the Shyamoli Showroom POS — AB-2610-0042"). */
  cause?: string | null;
};

const ZERO_SPLIT = { atHubQty: 0, incomingQty: 0, transferQty: 0, backorderQty: 0, transferFrom: Prisma.DbNull };

const RANK: Record<FulfilmentStatusValue, number> = { READY_TO_PACK: 0, NEEDS_TRANSFER: 1, WAITING_FOR_STOCK: 2 };


export { FULFILMENT_STATUS_LABELS };

export async function settleFulfilment(tx: Tx, opts: SettleOptions = {}): Promise<FulfilmentTransition[]> {
  const queued = await tx.$queryRaw<{ variantId: string; maxId: bigint }[]>`
    SELECT "variantId", MAX("id") AS "maxId" FROM "fulfilment_queue" GROUP BY "variantId"
  `;
  const transitions: FulfilmentTransition[] = [];
  if (queued.length > 0) {
    const maxId = queued.reduce((m, q) => (q.maxId > m ? q.maxId : m), BigInt(0));
    const everything = queued.some((q) => q.variantId === "*");
    const variantIds = everything ? undefined : queued.map((q) => q.variantId);
    transitions.push(...(await recompute(tx, variantIds, maxId, opts)));
    await tx.$executeRaw`DELETE FROM "fulfilment_queue" WHERE "id" <= ${maxId}`;
  }
  // An order that left Confirmed (packed, cancelled, on hold, trashed) has no fulfilment.
  const left = await tx.order.findMany({ where: { fulfilmentStatus: { not: null }, NOT: ALLOCATED_ORDERS }, select: { id: true } });
  if (left.length > 0) {
    const ids = left.map((o) => o.id);
    await tx.order.updateMany({ where: { id: { in: ids } }, data: { fulfilmentStatus: null, waitingSince: null, fulfilmentChangedAt: new Date() } });
    await tx.orderItem.updateMany({ where: { orderId: { in: ids } }, data: ZERO_SPLIT });
  }
  return transitions;
}

/**
 * For screens that show fulfilment: settles first if anything is queued
 * (one cheap query when nothing is), so a status is never read stale.
 */
export async function settleIfPending(db: Db): Promise<void> {
  const [row] = await db.$queryRaw<{ pending: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "fulfilment_queue") AS "pending"`;
  if (row?.pending) await withTx(db, (tx) => settleFulfilment(tx));
}

async function recompute(tx: Tx, variantIds: string[] | undefined, seq: bigint, opts: SettleOptions): Promise<FulfilmentTransition[]> {
  const { lines, locations, hub } = await computeAllocation(tx, variantIds);
  const names = new Map(locations.map((l) => [l.id, l.name]));

  // 1. Each line's split, written only where it changed.
  const stored = new Map(
    (
      await tx.orderItem.findMany({
        where: { id: { in: lines.map((l) => l.itemId) } },
        select: { id: true, atHubQty: true, incomingQty: true, transferQty: true, backorderQty: true, transferFrom: true },
      })
    ).map((i) => [i.id, i]),
  );
  for (const line of lines) {
    const split = splitOf(line);
    // Named, so the order screen can say where the units are (a rename re-settles everything).
    const transferFrom = line.fromLocations.length > 0 ? line.fromLocations.map((f) => ({ ...f, locationName: names.get(f.locationId) ?? "" })) : null;
    const was = stored.get(line.itemId);
    if (
      was &&
      was.atHubQty === split.atHubQty &&
      was.incomingQty === split.incomingQty &&
      was.transferQty === split.transferQty &&
      was.backorderQty === split.backorderQty &&
      JSON.stringify(was.transferFrom ?? null) === JSON.stringify(transferFrom)
    )
      continue;
    await tx.orderItem.update({
      where: { id: line.itemId },
      data: { atHubQty: split.atHubQty, incomingQty: split.incomingQty, transferQty: split.transferQty, backorderQty: split.backorderQty, transferFrom: transferFrom ?? Prisma.DbNull },
    });
  }
  // Lines of these variants on orders that no longer hold units: nothing allocated.
  if (variantIds) {
    await tx.orderItem.updateMany({
      where: { variantId: { in: variantIds }, order: { NOT: ALLOCATED_ORDERS }, OR: [{ atHubQty: { gt: 0 } }, { incomingQty: { gt: 0 } }, { transferQty: { gt: 0 } }, { backorderQty: { gt: 0 } }] },
      data: ZERO_SPLIT,
    });
  }

  // 2. Each affected order's status, from ALL of its lines.
  const orderIds = [...new Set(lines.map((l) => l.orderId))].sort();
  if (orderIds.length === 0) return [];
  const orders = await tx.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, orderNo: true, createdById: true, fulfilmentStatus: true, items: { select: { qty: true, atHubQty: true, incomingQty: true, transferQty: true, backorderQty: true } } },
  });
  const now = new Date();
  const transitions: FulfilmentTransition[] = [];
  for (const o of orders) {
    const to = fulfilmentStatusOf(o.items as LineSplit[]);
    if (o.fulfilmentStatus === to) continue;
    // Guarded: if another settle got here first, it records (and announces) the change.
    const moved = await tx.order.updateMany({
      where: { id: o.id, fulfilmentStatus: o.fulfilmentStatus },
      data: {
        fulfilmentStatus: to,
        fulfilmentChangedAt: now,
        ...(to === "WAITING_FOR_STOCK" ? { waitingSince: now } : { waitingSince: null, stockExpectedOn: null }),
      },
    });
    if (moved.count === 1) transitions.push({ orderId: o.id, orderNo: o.orderNo, from: o.fulfilmentStatus, to, createdById: o.createdById });
  }
  await notifyTransitions(tx, transitions, { seq, cause: opts.cause ?? null, hubId: hub.id, locationNames: new Map(locations.map((l) => [l.id, l.name])) });
  return transitions;
}

/**
 * Item 12: when stock arrives, packing and the order's SE are told; item
 * 13 / the POS conflict: when an order loses a unit it was counting on, its
 * SE is told. An order's first status (just placed) tells nobody.
 */
async function notifyTransitions(
  tx: Tx,
  transitions: FulfilmentTransition[],
  ctx: { seq: bigint; cause: string | null; hubId: string; locationNames: Map<string, string> },
): Promise<void> {
  const changes = transitions.filter((t) => t.from !== null && t.to !== null);
  if (changes.length === 0) return;
  const packers = changes.some((t) => t.to === "READY_TO_PACK") ? await packingStaff(tx, ctx.hubId) : [];
  const data: Prisma.NotificationCreateManyInput[] = [];
  for (const t of changes) {
    const from = t.from!;
    const to = t.to!;
    const better = RANK[to] < RANK[from];
    const dedupeKey = `fulfilment:${t.orderId}:${from}>${to}:${ctx.seq}`;
    const href = `/orders/${t.orderId}`;
    const cause = ctx.cause ? ` ${ctx.cause}.` : "";
    if (better) {
      const title = to === "READY_TO_PACK" ? `${t.orderNo} is ready to pack` : `${t.orderNo}: stock found — needs a transfer to the hub`;
      const body =
        to === "READY_TO_PACK"
          ? `Everything on ${t.orderNo} is at the packing hub now (it was ${FULFILMENT_STATUS_LABELS[from].toLowerCase()}).${cause}`
          : `What ${t.orderNo} was waiting for is in stock at another location — it shows on that location's "Needed at the packing hub" list.${cause}`;
      const people = new Set([...(t.createdById ? [t.createdById] : []), ...(to === "READY_TO_PACK" ? packers : [])]);
      for (const userId of people) data.push({ userId, kind: "ORDER_STOCK_ARRIVED", title, body, href, dedupeKey });
    } else if (t.createdById) {
      data.push({
        userId: t.createdById,
        kind: "ORDER_STOCK_LOST",
        title: `${t.orderNo} is now ${FULFILMENT_STATUS_LABELS[to].toLowerCase()}`,
        body: `A piece ${t.orderNo} was counting on is gone (it was ${FULFILMENT_STATUS_LABELS[from].toLowerCase()}).${cause} Check the order — the customer may need a call.`,
        href,
        dedupeKey,
      });
    }
  }
  if (data.length > 0) await tx.notification.createMany({ data, skipDuplicates: true });
}

/** Who packs: active users holding packing.pack who act at the hub (assigned to it, or location.all). */
async function packingStaff(tx: Tx, hubId: string): Promise<string[]> {
  const users = await tx.user.findMany({ where: { isActive: true }, select: { id: true, locations: { where: { locationId: hubId }, select: { locationId: true } } } });
  const out: string[] = [];
  for (const u of users) {
    const held = await loadEffectivePermissions(tx, u.id);
    if (held.has("packing.pack") && (u.locations.length > 0 || held.has("location.all"))) out.push(u.id);
  }
  return out;
}

/**
 * Every place the stored fulfilment disagrees with the allocation computed
 * now (after a settle). Always empty — the tests use it like the ledger's
 * divergence finder.
 */
export async function findFulfilmentDivergences(tx: Tx): Promise<{ orderId: string; itemId?: string; stored: unknown; computed: unknown }[]> {
  const { lines } = await computeAllocation(tx);
  const out: { orderId: string; itemId?: string; stored: unknown; computed: unknown }[] = [];
  const items = new Map(
    (await tx.orderItem.findMany({ where: { order: ALLOCATED_ORDERS }, select: { id: true, orderId: true, qty: true, atHubQty: true, incomingQty: true, transferQty: true, backorderQty: true } })).map((i) => [i.id, i]),
  );
  for (const line of lines) {
    const s = items.get(line.itemId);
    const c = splitOf(line);
    if (!s || s.atHubQty !== c.atHubQty || s.incomingQty !== c.incomingQty || s.transferQty !== c.transferQty || s.backorderQty !== c.backorderQty) {
      out.push({ orderId: line.orderId, itemId: line.itemId, stored: s ?? null, computed: c });
    }
  }
  const orders = await tx.order.findMany({ where: ALLOCATED_ORDERS, select: { id: true, fulfilmentStatus: true, items: { select: { qty: true, atHubQty: true, incomingQty: true, transferQty: true, backorderQty: true } } } });
  for (const o of orders) {
    const computed = fulfilmentStatusOf(o.items as LineSplit[]);
    if (o.fulfilmentStatus !== computed) out.push({ orderId: o.id, stored: o.fulfilmentStatus, computed });
  }
  const stray = await tx.order.findMany({ where: { fulfilmentStatus: { not: null }, NOT: ALLOCATED_ORDERS }, select: { id: true, fulfilmentStatus: true } });
  for (const o of stray) out.push({ orderId: o.id, stored: o.fulfilmentStatus, computed: null });
  return out;
}
