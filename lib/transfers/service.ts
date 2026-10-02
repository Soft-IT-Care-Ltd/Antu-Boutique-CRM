import "server-only";

import { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { can } from "@/lib/auth/permissions";
import type { PermissionKey } from "@/lib/auth/permission-definitions";
import type { SessionUser } from "@/lib/auth/types";
import type { Db } from "@/lib/db/tx";
import { postStockExpense } from "@/lib/inventory/adjustments";
import { settleFulfilment } from "@/lib/fulfilment/settle";
import { nextDocumentNumber } from "@/lib/inventory/document-number";
import { lockVariantAt, recordStockMovement } from "@/lib/inventory/ledger";
import { findVariantByScan, scannedItem, ScanError } from "@/lib/inventory/scan-lookup";
import { canActAt, getLocationAccess, type LocationAccess } from "@/lib/locations/service";
import { findShelfByScan } from "@/lib/shelves/scan";
import type { TransferLineView, TransferListItem, TransferStatusValue, TransferTab, TransferView } from "@/lib/transfers/constants";

// C4 — CORRECTIONS.md item 3: stock transfers between locations.
//
//   Draft ──Send──▶ In transit ──Receive──▶ Received
//     │                                 └─▶ Received with difference
//     └─Cancel──▶ Cancelled                   (missing → found / written off)
//
// Stock moves only at Send and Receive (and when a missing unit is found or
// written off), always as ledger PAIRS through recordStockMovement:
//   Send     : source −n  (TRANSFER_SEND)   + in transit +n (TRANSFER_SEND)
//   Receive  : in transit −n (TRANSFER_RECEIVE) + destination +n (TRANSFER_RECEIVE)
//   Found    : same as Receive, later
//   Write off: in transit −n (TRANSIT_WRITE_OFF) + a "Stock shortage" expense at cost
// so total stock never changes except by a write-off, and in transit is
// never at any location.
//
// Every mutation first locks the transfer row (SELECT … FOR UPDATE): a scan
// can never land on a transfer that is being sent or received at the same
// moment. Only the source's people send and only the destination's
// receive; location.all (Admin, Manager) does both.

export class TransferError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export { ScanError };

export type AuditMeta = { request?: Request };

type TransferRow = { id: string; transferNo: string; status: TransferStatusValue; fromLocationId: string; toLocationId: string };

async function lockTransfer(tx: Prisma.TransactionClient, id: string): Promise<TransferRow> {
  const rows = await tx.$queryRaw<TransferRow[]>`
    SELECT "id", "transferNo", "status"::text AS "status", "fromLocationId", "toLocationId"
    FROM "stock_transfers" WHERE "id" = ${id} FOR UPDATE
  `;
  if (!rows[0]) throw new TransferError("Transfer not found.", 404);
  return rows[0];
}

async function locationName(db: Db, id: string): Promise<string> {
  return (await db.location.findUnique({ where: { id }, select: { name: true } }))?.name ?? "that location";
}

/** The person holds `permission` and acts for `locationId` — else a 403 naming the place. */
async function assertActor(db: Db, user: SessionUser, permission: PermissionKey, locationId: string, what: string): Promise<void> {
  if (!(await can(user, permission))) throw new TransferError(`You can't ${what}.`, 403);
  if (!canActAt(await getLocationAccess(db, user), locationId)) throw new TransferError(`Only ${await locationName(db, locationId)}'s people can ${what}.`, 403);
}

function requireStatus(t: TransferRow, allowed: TransferStatusValue[], what: string): void {
  if (!allowed.includes(t.status)) {
    const now = { DRAFT: "still a draft", IN_TRANSIT: "already on its way", RECEIVED: "already received", RECEIVED_WITH_DIFFERENCE: "already received", CANCELLED: "cancelled" }[t.status];
    throw new TransferError(`${t.transferNo} is ${now} — you can't ${what}.`, 409);
  }
}

// ── Create ──────────────────────────────────────────────────────────────

export type CreateTransferInput = {
  fromLocationId: string;
  toLocationId: string;
  note?: string | null;
  /** Pre-filled lines (from "Needed at the packing hub"). */
  lines?: { variantId: string; qtyRequested: number }[];
  orderIds?: string[];
};

export async function createTransfer(tx: Prisma.TransactionClient, user: SessionUser, input: CreateTransferInput): Promise<{ id: string; transferNo: string }> {
  if (input.fromLocationId === input.toLocationId) throw new TransferError("Pick a different location to send to.");
  await assertActor(tx, user, "transfer.send", input.fromLocationId, "send stock from there");
  const locations = await tx.location.findMany({ where: { id: { in: [input.fromLocationId, input.toLocationId] } }, select: { id: true, name: true, isActive: true } });
  if (locations.length !== 2) throw new TransferError("That location doesn't exist.");
  const off = locations.find((l) => !l.isActive);
  if (off) throw new TransferError(`${off.name} is switched off.`);

  const transferNo = await nextDocumentNumber(tx, "TR");
  const lines = new Map<string, number>();
  for (const l of input.lines ?? []) lines.set(l.variantId, (lines.get(l.variantId) ?? 0) + l.qtyRequested);
  const transfer = await tx.stockTransfer.create({
    data: {
      transferNo,
      fromLocationId: input.fromLocationId,
      toLocationId: input.toLocationId,
      note: input.note?.trim() || null,
      createdById: user.id,
      lines: { create: [...lines].map(([variantId, qtyRequested]) => ({ variantId, qtyRequested })) },
      orders: { create: [...new Set(input.orderIds ?? [])].map((orderId) => ({ orderId })) },
    },
    select: { id: true, transferNo: true },
  });
  // C5 — a Draft to the hub is promised supply: its orders move to Needs transfer.
  await settleFulfilment(tx);
  return transfer;
}

// ── Scanning (both sides) ───────────────────────────────────────────────

export type ScanSide = "send" | "receive";

export type ScanOutcome = {
  item: ReturnType<typeof scannedItem> | null;
  count: number;
  of: number | null;
  message: string;
  /** C4b — a shelf label was scanned: the next dresses come off this shelf. */
  shelf?: { id: string; code: string };
};

/** C4b — of a line's units sent, how many were scanned off which shelf. */
type ShelfPicks = Record<string, number>;

function readPicks(json: Prisma.JsonValue | null | undefined): ShelfPicks {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  return Object.fromEntries(Object.entries(json).filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0));
}

/** Keeps the picks within `qty` units (the last-scanned shelves give way first). */
function trimPicks(picks: ShelfPicks, qty: number): ShelfPicks {
  const out: ShelfPicks = {};
  let left = qty;
  for (const [shelfId, n] of Object.entries(picks)) {
    const keep = Math.min(n, left);
    if (keep > 0) out[shelfId] = keep;
    left -= keep;
  }
  return out;
}

/**
 * One scan = one unit. Sending: adds the unit to the Draft (refused when the
 * source doesn't show that many). Receiving: ticks one unit of what was
 * sent (a tag that isn't on the transfer, or one scanned more times than
 * were sent, is refused).
 */
export async function scanTransferUnit(
  tx: Prisma.TransactionClient,
  user: SessionUser,
  transferId: string,
  side: ScanSide,
  raw: string,
  /** C4b — the shelf label scanned before this dress (send side). */
  opts: { shelfId?: string | null } = {},
): Promise<ScanOutcome> {
  const t = await lockTransfer(tx, transferId);

  if (side === "send") {
    // C4b — a shelf label: the dresses scanned next come off that shelf.
    const shelf = await findShelfByScan(tx, raw, t.fromLocationId);
    if (shelf) {
      requireStatus(t, ["DRAFT"], "add items");
      await assertActor(tx, user, "transfer.send", t.fromLocationId, "send stock from there");
      return { item: null, shelf, count: 0, of: null, message: `Shelf ${shelf.code} — now scan the dresses you take off it` };
    }
  }
  const variant = await findVariantByScan(tx, raw);
  const item = scannedItem(variant);

  if (side === "send") {
    requireStatus(t, ["DRAFT"], "add items");
    await assertActor(tx, user, "transfer.send", t.fromLocationId, "send stock from there");
    const [line, atSource] = await Promise.all([
      tx.stockTransferLine.findUnique({ where: { transferId_variantId: { transferId, variantId: variant.id } }, select: { qtySent: true, qtyRequested: true, shelfPicks: true } }),
      tx.variantStock.findUnique({ where: { variantId_locationId: { variantId: variant.id, locationId: t.fromLocationId } }, select: { qty: true } }),
    ]);
    const next = (line?.qtySent ?? 0) + 1;
    const have = atSource?.qty ?? 0;
    if (next > have) {
      throw new ScanError(`${variant.sku}: ${await locationName(tx, t.fromLocationId)} shows only ${Math.max(0, have)} — can't send ${next}. Count it first if the dress is really here.`, 409);
    }
    // C4b — taken off the scanned shelf: that shelf must hold one more of it.
    const picks = readPicks(line?.shelfPicks);
    let shelfCode: string | null = null;
    if (opts.shelfId) {
      const onShelf = await tx.shelfStock.findFirst({ where: { shelfId: opts.shelfId, variantId: variant.id, locationId: t.fromLocationId }, select: { qty: true } });
      const shelfRow = await tx.shelf.findFirst({ where: { id: opts.shelfId, locationId: t.fromLocationId }, select: { code: true } });
      if (!shelfRow) throw new ScanError("That shelf isn't at this location — scan the shelf label again.", 409);
      const pickedThere = (picks[opts.shelfId] ?? 0) + 1;
      if (pickedThere > (onShelf?.qty ?? 0)) {
        throw new ScanError(`${variant.sku}: shelf ${shelfRow.code} shows ${onShelf?.qty ?? 0}${pickedThere > 1 ? ` and ${pickedThere - 1} already scanned off it` : ""}. Scan the shelf it really came from, or scan the dress alone.`, 409);
      }
      picks[opts.shelfId] = pickedThere;
      shelfCode = shelfRow.code;
    }
    const shelfPicks = Object.keys(picks).length ? picks : Prisma.DbNull;
    await tx.stockTransferLine.upsert({
      where: { transferId_variantId: { transferId, variantId: variant.id } },
      create: { transferId, variantId: variant.id, qtySent: 1, shelfPicks },
      update: { qtySent: { increment: 1 }, shelfPicks },
    });
    const of = line?.qtyRequested ? line.qtyRequested : null;
    const from = shelfCode ? ` · off ${shelfCode}` : "";
    return { item, count: next, of, message: of && next > of ? `${variant.sku}: ${next} scanned — only ${of} asked for${from}` : `${variant.sku} · ${next}${of ? ` of ${of}` : ""}${from}` };
  }

  requireStatus(t, ["IN_TRANSIT"], "scan items in");
  await assertActor(tx, user, "transfer.receive", t.toLocationId, "receive stock there");
  const line = await tx.stockTransferLine.findUnique({ where: { transferId_variantId: { transferId, variantId: variant.id } }, select: { id: true, qtySent: true, qtyScannedIn: true } });
  if (!line || line.qtySent === 0) throw new ScanError(`${variant.sku} (${variant.product.name}) isn't on ${t.transferNo}. Put it aside — it wasn't sent on this transfer.`, 409);
  if (line.qtyScannedIn >= line.qtySent) throw new ScanError(`${variant.sku}: all ${line.qtySent} sent are already scanned — this one is extra.`, 409);
  await tx.stockTransferLine.update({ where: { id: line.id }, data: { qtyScannedIn: { increment: 1 } } });
  return { item, count: line.qtyScannedIn + 1, of: line.qtySent, message: `${variant.sku} · ${line.qtyScannedIn + 1} of ${line.qtySent}` };
}

/** Typing a quantity instead of scanning (or taking a mis-scan back). */
export async function setTransferLineQty(tx: Prisma.TransactionClient, user: SessionUser, transferId: string, side: ScanSide, variantId: string, qty: number): Promise<void> {
  if (!Number.isInteger(qty) || qty < 0) throw new TransferError("Quantity must be a whole number, 0 or more.");
  const t = await lockTransfer(tx, transferId);
  const line = await tx.stockTransferLine.findUnique({ where: { transferId_variantId: { transferId, variantId } }, select: { id: true, qtyRequested: true, qtySent: true, shelfPicks: true } });

  if (side === "send") {
    requireStatus(t, ["DRAFT"], "change what's sent");
    await assertActor(tx, user, "transfer.send", t.fromLocationId, "send stock from there");
    if (!line) throw new TransferError("That item isn't on this transfer — scan it to add it.", 404);
    if (qty > 0) {
      const atSource = await tx.variantStock.findUnique({ where: { variantId_locationId: { variantId, locationId: t.fromLocationId } }, select: { qty: true } });
      if (qty > (atSource?.qty ?? 0)) throw new TransferError(`${await locationName(tx, t.fromLocationId)} shows only ${Math.max(0, atSource?.qty ?? 0)} of it.`, 409);
    }
    if (qty === 0 && line.qtyRequested === 0) await tx.stockTransferLine.delete({ where: { id: line.id } });
    else {
      const picks = trimPicks(readPicks(line.shelfPicks), qty);
      await tx.stockTransferLine.update({ where: { id: line.id }, data: { qtySent: qty, shelfPicks: Object.keys(picks).length ? picks : Prisma.DbNull } });
    }
    return;
  }

  requireStatus(t, ["IN_TRANSIT"], "change what's received");
  await assertActor(tx, user, "transfer.receive", t.toLocationId, "receive stock there");
  if (!line || line.qtySent === 0) throw new TransferError("That item isn't on this transfer.", 404);
  if (qty > line.qtySent) throw new TransferError(`Only ${line.qtySent} were sent.`);
  await tx.stockTransferLine.update({ where: { id: line.id }, data: { qtyScannedIn: qty } });
}

// ── Send ────────────────────────────────────────────────────────────────

/** Moves every scanned unit out of the source into In transit, at today's weighted average cost. */
export async function sendTransfer(tx: Prisma.TransactionClient, user: SessionUser, transferId: string, meta: AuditMeta = {}): Promise<void> {
  const t = await lockTransfer(tx, transferId);
  requireStatus(t, ["DRAFT"], "send it");
  await assertActor(tx, user, "transfer.send", t.fromLocationId, "send stock from there");
  const to = await tx.location.findUniqueOrThrow({ where: { id: t.toLocationId }, select: { name: true, isActive: true } });
  if (!to.isActive) throw new TransferError(`${to.name} is switched off.`);

  const lines = (await tx.stockTransferLine.findMany({ where: { transferId }, select: { id: true, variantId: true, qtySent: true, shelfPicks: true, variant: { select: { sku: true } } } }))
    .filter((l) => l.qtySent > 0)
    .sort((a, b) => a.variantId.localeCompare(b.variantId));
  if (lines.length === 0) throw new TransferError("Scan at least one item before sending.");

  // Lock every variant (id order — no deadlock with another stock writer)
  // and check the source still has it before anything moves.
  const short: string[] = [];
  const cost = new Map<string, Prisma.Decimal>();
  for (const line of lines) {
    const locked = await lockVariantAt(tx, line.variantId, t.fromLocationId);
    if (!locked) throw new TransferError("One of the items is no longer in the catalog.");
    if (locked.locationQty < line.qtySent) short.push(`${line.variant.sku} (${Math.max(0, locked.locationQty)} there, ${line.qtySent} scanned)`);
    cost.set(line.variantId, locked.weightedAvgCost);
  }
  if (short.length > 0) throw new TransferError(`Not enough at ${await locationName(tx, t.fromLocationId)}: ${short.join("; ")}. Take the extra off, or count the location first.`, 409);

  for (const line of lines) {
    const unitCost = cost.get(line.variantId)!;
    const common = { variantId: line.variantId, type: "TRANSFER_SEND" as const, unitCost, referenceType: "TRANSFER" as const, referenceId: transferId, actorId: user.id, note: `${t.transferNo} → ${to.name}` };
    // C4b — units scanned off a shelf leave that shelf; the rest, Unassigned first.
    const fromShelves = Object.entries(trimPicks(readPicks(line.shelfPicks), line.qtySent)).map(([shelfId, qty]) => ({ shelfId, qty }));
    await recordStockMovement(tx, { ...common, locationId: t.fromLocationId, qty: -line.qtySent, fromShelves });
    await recordStockMovement(tx, { ...common, locationId: null, qty: line.qtySent });
    await tx.stockTransferLine.update({ where: { id: line.id }, data: { unitCost } });
  }
  const sentAt = new Date();
  await tx.stockTransfer.update({ where: { id: transferId }, data: { status: "IN_TRANSIT", sentById: user.id, sentAt } });

  await writeAuditLogWith(tx, {
    actorId: user.id,
    action: "transfer.send",
    entityType: "stock_transfer",
    entityId: transferId,
    before: { status: "DRAFT" },
    after: { status: "IN_TRANSIT", transferNo: t.transferNo, from: await locationName(tx, t.fromLocationId), to: to.name, lines: lines.map((l) => ({ sku: l.variant.sku, qty: l.qtySent })) },
    request: meta.request,
  });
  await settleFulfilment(tx, { cause: `${t.transferNo} was sent from ${await locationName(tx, t.fromLocationId)}` });
}

// ── Receive ─────────────────────────────────────────────────────────────

/**
 * Puts every unit scanned in onto the destination. Anything sent but not
 * scanned stays "missing in transit" (Received with difference) until a
 * manager marks it found or writes it off.
 */
export async function receiveTransfer(tx: Prisma.TransactionClient, user: SessionUser, transferId: string, meta: AuditMeta = {}): Promise<{ status: TransferStatusValue; missing: number }> {
  const t = await lockTransfer(tx, transferId);
  requireStatus(t, ["IN_TRANSIT"], "receive it");
  await assertActor(tx, user, "transfer.receive", t.toLocationId, "receive stock there");

  const lines = (
    await tx.stockTransferLine.findMany({ where: { transferId }, select: { id: true, variantId: true, qtySent: true, qtyScannedIn: true, unitCost: true, variant: { select: { sku: true, weightedAvgCost: true } } } })
  )
    .filter((l) => l.qtySent > 0)
    .sort((a, b) => a.variantId.localeCompare(b.variantId));

  const fromName = await locationName(tx, t.fromLocationId);
  let missing = 0;
  for (const line of lines) {
    missing += line.qtySent - line.qtyScannedIn;
    if (line.qtyScannedIn === 0) continue;
    await moveOutOfTransit(tx, { variantId: line.variantId, qty: line.qtyScannedIn, toLocationId: t.toLocationId, unitCost: line.unitCost ?? line.variant.weightedAvgCost, transferId, actorId: user.id, note: `${t.transferNo} from ${fromName}` });
    await tx.stockTransferLine.update({ where: { id: line.id }, data: { qtyReceived: line.qtyScannedIn } });
  }

  const status: TransferStatusValue = missing > 0 ? "RECEIVED_WITH_DIFFERENCE" : "RECEIVED";
  await tx.stockTransfer.update({ where: { id: transferId }, data: { status, receivedById: user.id, receivedAt: new Date() } });

  await writeAuditLogWith(tx, {
    actorId: user.id,
    action: "transfer.receive",
    entityType: "stock_transfer",
    entityId: transferId,
    before: { status: "IN_TRANSIT" },
    after: {
      status,
      transferNo: t.transferNo,
      to: await locationName(tx, t.toLocationId),
      lines: lines.map((l) => ({ sku: l.variant.sku, sent: l.qtySent, received: l.qtyScannedIn })),
      missing,
    },
    request: meta.request,
  });
  // C5 — what arrived goes to waiting orders, oldest first (CORRECTIONS.md item 12).
  await settleFulfilment(tx, { cause: `${t.transferNo} was received at ${await locationName(tx, t.toLocationId)}` });
  return { status, missing };
}

async function moveOutOfTransit(
  tx: Prisma.TransactionClient,
  input: { variantId: string; qty: number; toLocationId: string; unitCost: Prisma.Decimal; transferId: string; actorId: string; note: string },
): Promise<void> {
  const common = { variantId: input.variantId, type: "TRANSFER_RECEIVE" as const, unitCost: input.unitCost, referenceType: "TRANSFER" as const, referenceId: input.transferId, actorId: input.actorId, note: input.note };
  // The variant lock first, like every stock writer.
  await lockVariantAt(tx, input.variantId, input.toLocationId);
  await recordStockMovement(tx, { ...common, locationId: null, qty: -input.qty });
  await recordStockMovement(tx, { ...common, locationId: input.toLocationId, qty: input.qty });
}

// ── Differences ─────────────────────────────────────────────────────────

export type ResolveMissingInput = { variantId: string; action: "FOUND" | "WRITE_OFF"; qty: number; reason: string };

/**
 * A unit missing in transit is either FOUND (it turned up — received now,
 * onto the destination) or WRITTEN OFF (lost — out of stock, its cost
 * booked under "Stock shortage", same as a count shortfall).
 */
export async function resolveMissing(tx: Prisma.TransactionClient, user: SessionUser, transferId: string, input: ResolveMissingInput, meta: AuditMeta = {}): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) throw new TransferError("Say what happened to it.");
  if (!Number.isInteger(input.qty) || input.qty < 1) throw new TransferError("Quantity must be at least 1.");
  const t = await lockTransfer(tx, transferId);
  requireStatus(t, ["RECEIVED_WITH_DIFFERENCE"], "resolve a difference");
  await assertActor(tx, user, "transfer.resolve", t.toLocationId, "resolve missing stock there");

  const line = await tx.stockTransferLine.findUnique({
    where: { transferId_variantId: { transferId, variantId: input.variantId } },
    select: { id: true, qtySent: true, qtyReceived: true, qtyFound: true, qtyWrittenOff: true, unitCost: true, variant: { select: { sku: true, weightedAvgCost: true } } },
  });
  if (!line) throw new TransferError("That item isn't on this transfer.", 404);
  const missing = line.qtySent - line.qtyReceived - line.qtyFound - line.qtyWrittenOff;
  if (input.qty > missing) throw new TransferError(`Only ${missing} of ${line.variant.sku} ${missing === 1 ? "is" : "are"} missing.`, 409);
  const unitCost = line.unitCost ?? line.variant.weightedAvgCost;

  if (input.action === "FOUND") {
    await moveOutOfTransit(tx, { variantId: input.variantId, qty: input.qty, toLocationId: t.toLocationId, unitCost, transferId, actorId: user.id, note: `${t.transferNo}: found — ${reason}` });
    await tx.stockTransferLine.update({ where: { id: line.id }, data: { qtyFound: { increment: input.qty } } });
  } else {
    await lockVariantAt(tx, input.variantId, t.toLocationId);
    const movement = await recordStockMovement(tx, {
      variantId: input.variantId,
      locationId: null,
      type: "TRANSIT_WRITE_OFF",
      qty: -input.qty,
      unitCost,
      referenceType: "TRANSFER",
      referenceId: transferId,
      actorId: user.id,
      note: `${t.transferNo}: missing in transit — ${reason}`,
    });
    await postStockExpense(tx, movement, "SHORTAGE", `Missing in transit: ${input.qty} × ${line.variant.sku} on ${t.transferNo} — ${reason}`, user.id);
    await tx.stockTransferLine.update({ where: { id: line.id }, data: { qtyWrittenOff: { increment: input.qty } } });
  }

  await writeAuditLogWith(tx, {
    actorId: user.id,
    action: input.action === "FOUND" ? "transfer.missing_found" : "transfer.missing_write_off",
    entityType: "stock_transfer",
    entityId: transferId,
    before: { sku: line.variant.sku, missing },
    after: { sku: line.variant.sku, missing: missing - input.qty, qty: input.qty, reason, transferNo: t.transferNo },
    request: meta.request,
  });
  await settleFulfilment(tx, { cause: input.action === "FOUND" ? `Missing units on ${t.transferNo} were found` : null });
}

// ── Cancel ──────────────────────────────────────────────────────────────

/** Only a Draft can be cancelled — nothing has moved yet. */
export async function cancelTransfer(tx: Prisma.TransactionClient, user: SessionUser, transferId: string, reason: string, meta: AuditMeta = {}): Promise<void> {
  const why = reason.trim();
  if (!why) throw new TransferError("Say why it's cancelled.");
  const t = await lockTransfer(tx, transferId);
  requireStatus(t, ["DRAFT"], "cancel it (only a draft can be cancelled)");
  await assertActor(tx, user, "transfer.send", t.fromLocationId, "cancel a transfer from there");
  await tx.stockTransfer.update({ where: { id: transferId }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: why } });
  await writeAuditLogWith(tx, {
    actorId: user.id,
    action: "transfer.cancel",
    entityType: "stock_transfer",
    entityId: transferId,
    before: { status: "DRAFT" },
    after: { status: "CANCELLED", reason: why, transferNo: t.transferNo },
    request: meta.request,
  });
  await settleFulfilment(tx, { cause: `Transfer ${t.transferNo} was cancelled` });
}

// ── Reading ─────────────────────────────────────────────────────────────

/** A transfer is visible to anyone acting at either end (location.all: all). */
export function transferScope(access: LocationAccess): Prisma.StockTransferWhereInput {
  return access.all ? {} : { OR: [{ fromLocationId: { in: access.ids } }, { toLocationId: { in: access.ids } }] };
}

export async function getTransferView(db: Db, user: SessionUser, transferId: string, opts: { withCost: boolean }): Promise<TransferView | null> {
  const access = await getLocationAccess(db, user);
  const t = await db.stockTransfer.findFirst({
    where: { id: transferId, ...transferScope(access) },
    include: {
      fromLocation: { select: { id: true, name: true } },
      toLocation: { select: { id: true, name: true, isPackingHub: true } },
      createdBy: { select: { name: true } },
      sentBy: { select: { name: true } },
      receivedBy: { select: { name: true } },
      orders: { select: { order: { select: { id: true, orderNo: true } } } },
      lines: {
        include: {
          variant: {
            select: {
              sku: true,
              size: { select: { name: true, sortOrder: true } },
              color: { select: { name: true, hexCode: true } },
              product: { select: { name: true, images: { orderBy: { sortOrder: "asc" }, take: 1, select: { thumbPath: true } } } },
              locationStocks: { select: { locationId: true, qty: true } },
            },
          },
        },
      },
    },
  });
  if (!t) return null;

  const [mayResolve, maySend, mayReceive] = await Promise.all([can(user, "transfer.resolve"), can(user, "transfer.send"), can(user, "transfer.receive")]);
  const atFrom = canActAt(access, t.fromLocationId);
  const atTo = canActAt(access, t.toLocationId);

  const lines: TransferLineView[] = t.lines
    .map((l) => ({
      variantId: l.variantId,
      sku: l.variant.sku,
      productName: l.variant.product.name,
      sizeName: l.variant.size.name,
      colorName: l.variant.color.name,
      colorHex: l.variant.color.hexCode,
      thumbPath: l.variant.product.images[0]?.thumbPath ?? null,
      qtyRequested: l.qtyRequested,
      qtySent: l.qtySent,
      qtyScannedIn: l.qtyScannedIn,
      qtyReceived: l.qtyReceived,
      qtyFound: l.qtyFound,
      qtyWrittenOff: l.qtyWrittenOff,
      missing: t.status === "RECEIVED" || t.status === "RECEIVED_WITH_DIFFERENCE" ? l.qtySent - l.qtyReceived - l.qtyFound - l.qtyWrittenOff : 0,
      atSource: t.status === "DRAFT" ? (l.variant.locationStocks.find((s) => s.locationId === t.fromLocationId)?.qty ?? 0) : null,
      ...(opts.withCost && l.unitCost ? { unitCost: l.unitCost.toString() } : {}),
    }))
    .sort((a, b) => a.productName.localeCompare(b.productName) || a.sku.localeCompare(b.sku));

  const sum = (k: "qtyRequested" | "qtySent" | "qtyScannedIn" | "qtyReceived" | "qtyFound" | "qtyWrittenOff" | "missing") => lines.reduce((a, l) => a + l[k], 0);
  const totals = { requested: sum("qtyRequested"), sent: sum("qtySent"), scannedIn: sum("qtyScannedIn"), received: sum("qtyReceived"), found: sum("qtyFound"), writtenOff: sum("qtyWrittenOff"), missing: sum("missing") };

  return {
    id: t.id,
    transferNo: t.transferNo,
    status: t.status,
    from: t.fromLocation,
    to: t.toLocation,
    note: t.note,
    createdByName: t.createdBy?.name ?? null,
    createdAt: t.createdAt.toISOString(),
    sentByName: t.sentBy?.name ?? null,
    sentAt: t.sentAt?.toISOString() ?? null,
    receivedByName: t.receivedBy?.name ?? null,
    receivedAt: t.receivedAt?.toISOString() ?? null,
    cancelledAt: t.cancelledAt?.toISOString() ?? null,
    cancelReason: t.cancelReason,
    orders: t.orders.map((o) => o.order),
    lines,
    totals,
    can: {
      editSend: t.status === "DRAFT" && maySend && atFrom,
      send: t.status === "DRAFT" && maySend && atFrom && totals.sent > 0,
      cancel: t.status === "DRAFT" && maySend && atFrom,
      receive: t.status === "IN_TRANSIT" && mayReceive && atTo,
      resolve: t.status === "RECEIVED_WITH_DIFFERENCE" && totals.missing > 0 && mayResolve && atTo,
    },
  };
}

export type TransferListQuery = { tab: TransferTab; locationId?: string; q?: string; from?: Date; to?: Date; page: number; pageSize: number };

const OPEN: TransferStatusValue[] = ["DRAFT", "IN_TRANSIT"];

export async function listTransfers(db: Db, user: SessionUser, query: TransferListQuery): Promise<{ items: TransferListItem[]; total: number; counts: Record<TransferTab, number> }> {
  const access = await getLocationAccess(db, user);
  const mine = access.all ? null : access.ids;
  const scope = transferScope(access);
  const base: Prisma.StockTransferWhereInput[] = [scope];
  if (query.locationId) base.push({ OR: [{ fromLocationId: query.locationId }, { toLocationId: query.locationId }] });
  if (query.q) base.push({ OR: [{ transferNo: { contains: query.q, mode: "insensitive" } }, { lines: { some: { variant: { sku: { contains: query.q, mode: "insensitive" } } } } }, { orders: { some: { order: { orderNo: { contains: query.q, mode: "insensitive" } } } } }] });

  // Missing in transit: received short, with some line still unresolved.
  const hasMissing = Prisma.sql`EXISTS (SELECT 1 FROM "stock_transfer_lines" l WHERE l."transferId" = t."id" AND l."qtySent" > l."qtyReceived" + l."qtyFound" + l."qtyWrittenOff")`;
  const missingIds = (await db.$queryRaw<{ id: string }[]>`SELECT t."id" FROM "stock_transfers" t WHERE t."status" = 'RECEIVED_WITH_DIFFERENCE' AND ${hasMissing}`).map((r) => r.id);

  const tabWhere = (tab: TransferTab): Prisma.StockTransferWhereInput => {
    switch (tab) {
      case "open":
        return { OR: [{ status: { in: OPEN } }, { id: { in: missingIds } }] };
      case "incoming":
        return { status: "IN_TRANSIT", ...(mine ? { toLocationId: { in: mine } } : {}) };
      case "outgoing":
        return { status: { in: OPEN }, ...(mine ? { fromLocationId: { in: mine } } : {}) };
      case "difference":
        return { id: { in: missingIds } };
      case "done":
        return { status: { in: ["RECEIVED", "RECEIVED_WITH_DIFFERENCE", "CANCELLED"] }, id: { notIn: missingIds } };
      case "all":
        return {};
    }
  };
  // Finished work is filtered by date; open work never is (C2 rule).
  const dated: Prisma.StockTransferWhereInput = query.from || query.to ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) } } : {};
  const whereFor = (tab: TransferTab): Prisma.StockTransferWhereInput => ({ AND: [...base, tabWhere(tab), tab === "done" || tab === "all" ? dated : {}] });

  const tabs = ["open", "incoming", "outgoing", "difference", "done", "all"] as const;
  const [rows, total, ...countValues] = await Promise.all([
    db.stockTransfer.findMany({
      where: whereFor(query.tab),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        fromLocation: { select: { name: true } },
        toLocation: { select: { name: true } },
        createdBy: { select: { name: true } },
        lines: { select: { qtyRequested: true, qtySent: true, qtyReceived: true, qtyFound: true, qtyWrittenOff: true } },
        _count: { select: { orders: true } },
      },
    }),
    db.stockTransfer.count({ where: whereFor(query.tab) }),
    ...tabs.map((tab) => db.stockTransfer.count({ where: whereFor(tab) })),
  ]);

  return {
    total,
    counts: Object.fromEntries(tabs.map((tab, i) => [tab, countValues[i]])) as Record<TransferTab, number>,
    items: rows.map((t) => {
      const received = t.status === "RECEIVED" || t.status === "RECEIVED_WITH_DIFFERENCE";
      return {
        id: t.id,
        transferNo: t.transferNo,
        status: t.status,
        fromName: t.fromLocation.name,
        toName: t.toLocation.name,
        units: t.lines.reduce((a, l) => a + (t.status === "DRAFT" ? Math.max(l.qtySent, l.qtyRequested) : l.qtySent), 0),
        missing: received ? t.lines.reduce((a, l) => a + l.qtySent - l.qtyReceived - l.qtyFound - l.qtyWrittenOff, 0) : 0,
        orderCount: t._count.orders,
        createdByName: t.createdBy?.name ?? null,
        createdAt: t.createdAt.toISOString(),
        sentAt: t.sentAt?.toISOString() ?? null,
        receivedAt: t.receivedAt?.toISOString() ?? null,
      };
    }),
  };
}
