import "server-only";

import { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import type { SessionUser } from "@/lib/auth/types";
import { withTx, type Db } from "@/lib/db/tx";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { dhakaDayStartUtc, todayInDhaka } from "@/lib/inventory/constants";
import { createExpense } from "@/lib/expenses/service";
import { CASH_OVER_SHORT_CATEGORY_ID, DEFAULT_POS_CASH_WALLET_ID, POS_CASH_WALLET_SETTING_KEY, type Denominations, type DrawerMovementKind } from "@/lib/pos/constants";
import type { DrawerFlowRow, DrawerHistoryItem, DrawerState, DrawerSummary } from "@/lib/pos/types";
import { getWalletBalances } from "@/lib/wallets/ledger";
import { createManualEntry, createTransfer } from "@/lib/wallets/service";

// PRD §4.7 — the daily showroom cash drawer.
//
// The drawer is the showroom cash wallet's physical cash. What should be in
// it at any moment is:
//
//   opening count
//   + cash payments into the wallet that day (POS sales, and any other cash
//     taken at the counter) — verified or not: unverified cash is in the
//     drawer, and the day-end count is what verifies it
//   − approved cash refunds paid out of it
//   − expenses paid from it, ± manual entries / transfers, + courier payouts
//
// — the same rows lib/wallets/ledger.ts derives the wallet's balance from,
// for one Dhaka business day. Closing freezes that figure, verifies the day's
// cash payments, and posts the difference to the count once, as a "Cash
// over/short" expense from the wallet (a shortage is a cost, an overage a
// credit), so the wallet's books follow the counted cash.

export class DrawerError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** The wallet that is the showroom drawer (Settings key, default "Showroom Cash"). Must be an active CASH wallet. */
export async function getPosCashWalletId(db: Db): Promise<string> {
  const setting = await db.setting.findUnique({ where: { key: POS_CASH_WALLET_SETTING_KEY } });
  const walletId = setting?.value || DEFAULT_POS_CASH_WALLET_ID;
  const wallet = await db.wallet.findUnique({ where: { id: walletId }, select: { type: true, isActive: true } });
  if (!wallet || !wallet.isActive || wallet.type !== "CASH") {
    throw new DrawerError("The showroom cash wallet is missing or inactive — ask an Admin to set it in Settings.", 409);
  }
  return walletId;
}

const drawerInclude = {
  wallet: { select: { name: true } },
  openedBy: { select: { name: true } },
  closedBy: { select: { name: true } },
  overShortExpense: { select: { id: true } },
} satisfies Prisma.CashDrawerInclude;

type DrawerRow = Prisma.CashDrawerGetPayload<{ include: typeof drawerInclude }>;

const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(d);

type Flows = { rows: DrawerFlowRow[]; cashSales: number; cashSalesCount: number; otherIn: number; out: number; unverified: number; unverifiedCount: number; unverifiedIds: string[] };

/**
 * Every movement of the drawer's wallet on its business day, in paisa. With
 * `frozenAt`, rows created after that instant are flagged (and left out of
 * the totals) — they were recorded after the count.
 */
async function loadFlows(db: Db, drawer: { id: string; walletId: string; businessDay: Date }, frozenAt: Date | null): Promise<Flows> {
  const from = drawer.businessDay;
  const to = dhakaDayStartUtc(dayKey(from), 1);
  const [payments, expenses, entries, payouts] = await Promise.all([
    db.payment.findMany({
      where: { walletId: drawer.walletId, paidAt: { gte: from, lt: to }, OR: [{ kind: "PAYMENT" }, { kind: "REFUND", refundStatus: "APPROVED" }] },
      select: { id: true, kind: true, amount: true, paidAt: true, verified: true, note: true, createdAt: true, decidedAt: true, order: { select: { id: true, orderNo: true, channel: true } } },
      orderBy: [{ paidAt: "asc" }, { id: "asc" }],
    }),
    db.expense.findMany({
      // This drawer's own over/short posting is the result of the count, not
      // a flow into it. (Spelled with an explicit null: SQL's NOT (col = x)
      // would also drop every expense whose cashDrawerId is null.)
      where: { walletId: drawer.walletId, deletedAt: null, expenseDate: { gte: from, lt: to }, OR: [{ cashDrawerId: null }, { cashDrawerId: { not: drawer.id } }] },
      select: { id: true, amount: true, expenseDate: true, note: true, createdAt: true, category: { select: { name: true } } },
      orderBy: [{ createdAt: "asc" }],
    }),
    db.walletEntry.findMany({
      where: { walletId: drawer.walletId, voidedAt: null, entryDate: { gte: from, lt: to } },
      select: { id: true, type: true, amount: true, note: true, createdAt: true, transferId: true },
      orderBy: [{ createdAt: "asc" }],
    }),
    db.courierStatement.findMany({
      where: { walletId: drawer.walletId, status: "PAID", statementDate: { gte: from, lt: to } },
      select: { id: true, netAmount: true, reference: true, statementDate: true, createdAt: true },
    }),
  ]);

  const flows: Flows = { rows: [], cashSales: 0, cashSalesCount: 0, otherIn: 0, out: 0, unverified: 0, unverifiedCount: 0, unverifiedIds: [] };
  const late = (created: Date) => frozenAt !== null && created > frozenAt;
  const push = (row: Omit<DrawerFlowRow, "amount">, paisa: number) => flows.rows.push({ ...row, amount: fromPaisa(paisa) });

  for (const p of payments) {
    const paisa = toPaisa(p.amount);
    const afterClose = late(p.kind === "REFUND" ? (p.decidedAt ?? p.createdAt) : p.createdAt);
    const isPos = p.order.channel === "WALK_IN";
    push(
      {
        id: p.id,
        source: p.kind === "REFUND" ? "REFUND" : "PAYMENT",
        at: p.paidAt.toISOString(),
        label: p.kind === "REFUND" ? "Cash refund" : isPos ? "POS sale" : "Cash payment on an online order",
        orderId: p.order.id,
        orderNo: p.order.orderNo,
        channel: p.order.channel,
        verified: p.kind === "PAYMENT" ? p.verified : null,
        note: p.note,
        afterClose,
      },
      paisa,
    );
    if (afterClose) continue;
    if (p.kind === "REFUND") flows.out += -paisa;
    else {
      if (isPos) {
        flows.cashSales += paisa;
        flows.cashSalesCount += 1;
      } else flows.otherIn += paisa;
      if (!p.verified) {
        flows.unverified += paisa;
        flows.unverifiedCount += 1;
        flows.unverifiedIds.push(p.id);
      }
    }
  }
  for (const e of expenses) {
    const paisa = toPaisa(e.amount);
    const afterClose = late(e.createdAt);
    push({ id: e.id, source: "EXPENSE", at: e.createdAt.toISOString(), label: `Expense — ${e.category.name}`, orderId: null, orderNo: null, channel: null, verified: null, note: e.note, afterClose }, -paisa);
    if (!afterClose) flows.out += paisa;
  }
  for (const w of entries) {
    const paisa = toPaisa(w.amount);
    const incoming = w.type === "MANUAL_IN" || w.type === "TRANSFER_IN";
    const afterClose = late(w.createdAt);
    const label = w.transferId ? (incoming ? "Transfer in" : "Transfer out") : incoming ? "Cash added" : "Cash taken out";
    push({ id: w.id, source: "ENTRY", at: w.createdAt.toISOString(), label, orderId: null, orderNo: null, channel: null, verified: null, note: w.note, afterClose }, incoming ? paisa : -paisa);
    if (afterClose) continue;
    if (incoming) flows.otherIn += paisa;
    else flows.out += paisa;
  }
  for (const s of payouts) {
    const paisa = toPaisa(s.netAmount);
    const afterClose = late(s.createdAt);
    push({ id: s.id, source: "COURIER_PAYOUT", at: s.statementDate.toISOString(), label: `Courier payout ${s.reference}`, orderId: null, orderNo: null, channel: null, verified: null, note: null, afterClose }, paisa);
    if (!afterClose) flows.otherIn += paisa;
  }
  flows.rows.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return flows;
}

const expectedPaisa = (openingCount: Prisma.Decimal, f: Flows) => toPaisa(openingCount) + f.cashSales + f.otherIn - f.out;

async function summarize(db: Db, drawer: DrawerRow): Promise<DrawerSummary> {
  const closed = drawer.status === "CLOSED";
  const [flows, [wallet]] = await Promise.all([loadFlows(db, drawer, closed ? drawer.closedAt : null), getWalletBalances(db, { walletId: drawer.walletId })]);
  return {
    id: drawer.id,
    walletId: drawer.walletId,
    walletName: drawer.wallet.name,
    businessDay: dayKey(drawer.businessDay),
    status: drawer.status,
    openedAt: drawer.openedAt.toISOString(),
    openedByName: drawer.openedBy?.name ?? null,
    openingCount: fromPaisa(toPaisa(drawer.openingCount)),
    openingDenominations: (drawer.openingDenominations as Denominations | null) ?? null,
    openingNote: drawer.openingNote,
    bookBalanceAtOpen: fromPaisa(toPaisa(drawer.bookBalanceAtOpen)),
    closedAt: drawer.closedAt?.toISOString() ?? null,
    closedByName: drawer.closedBy?.name ?? null,
    closingCount: drawer.closingCount ? fromPaisa(toPaisa(drawer.closingCount)) : null,
    closingDenominations: (drawer.closingDenominations as Denominations | null) ?? null,
    closeNote: drawer.closeNote,
    expectedClose: closed && drawer.expectedClose ? fromPaisa(toPaisa(drawer.expectedClose)) : fromPaisa(expectedPaisa(drawer.openingCount, flows)),
    difference: drawer.difference ? fromPaisa(toPaisa(drawer.difference)) : null,
    overShortExpenseId: drawer.overShortExpense?.id ?? null,
    totals: {
      cashSales: fromPaisa(flows.cashSales),
      cashSalesCount: flows.cashSalesCount,
      otherCashIn: fromPaisa(flows.otherIn),
      cashOut: fromPaisa(flows.out),
      unverified: fromPaisa(flows.unverified),
      unverifiedCount: flows.unverifiedCount,
    },
    rows: flows.rows,
    walletBalanceNow: wallet?.balance ?? "0.00",
  };
}

/** Where the POS stands: today's drawer (or an older one left open), and the last counted close. */
export async function getDrawerState(db: Db, walletId: string): Promise<DrawerState> {
  const today = todayInDhaka();
  const [wallet, open, todays, lastClosed] = await Promise.all([
    db.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { name: true } }),
    db.cashDrawer.findFirst({ where: { walletId, status: "OPEN" }, include: drawerInclude }),
    db.cashDrawer.findUnique({ where: { walletId_businessDay: { walletId, businessDay: dhakaDayStartUtc(today) } }, include: drawerInclude }),
    db.cashDrawer.findFirst({ where: { walletId, status: "CLOSED" }, orderBy: { businessDay: "desc" }, select: { closingCount: true, businessDay: true } }),
  ]);
  const drawer = open ?? todays;
  return {
    walletId,
    walletName: wallet.name,
    today,
    drawer: drawer ? await summarize(db, drawer) : null,
    lastClosingCount: lastClosed?.closingCount ? fromPaisa(toPaisa(lastClosed.closingCount)) : null,
    lastClosedDay: lastClosed ? dayKey(lastClosed.businessDay) : null,
  };
}

export async function getDrawerSummary(db: Db, drawerId: string): Promise<DrawerSummary | null> {
  const drawer = await db.cashDrawer.findUnique({ where: { id: drawerId }, include: drawerInclude });
  return drawer ? summarize(db, drawer) : null;
}

export async function listDrawers(db: Db, walletId: string, page: number, pageSize: number): Promise<{ items: DrawerHistoryItem[]; total: number }> {
  const [total, rows] = await Promise.all([
    db.cashDrawer.count({ where: { walletId } }),
    db.cashDrawer.findMany({ where: { walletId }, include: drawerInclude, orderBy: { businessDay: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  const items = await Promise.all(
    rows.map(async (d) => ({
      id: d.id,
      businessDay: dayKey(d.businessDay),
      status: d.status,
      openingCount: fromPaisa(toPaisa(d.openingCount)),
      // An open drawer's expected figure is live.
      expectedClose: d.expectedClose ? fromPaisa(toPaisa(d.expectedClose)) : fromPaisa(expectedPaisa(d.openingCount, await loadFlows(db, d, null))),
      closingCount: d.closingCount ? fromPaisa(toPaisa(d.closingCount)) : null,
      difference: d.difference ? fromPaisa(toPaisa(d.difference)) : null,
      openedByName: d.openedBy?.name ?? null,
      closedByName: d.closedBy?.name ?? null,
    })),
  );
  return { items, total };
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export type OpenDrawerInput = { openingCount: number; denominations?: Denominations | null; note?: string | null };

export async function openDrawer(db: Db, user: SessionUser, walletId: string, input: OpenDrawerInput): Promise<DrawerSummary> {
  const today = todayInDhaka();
  const businessDay = dhakaDayStartUtc(today);
  try {
    const drawerId = await withTx(db, async (tx) => {
      const open = await tx.cashDrawer.findFirst({ where: { walletId, status: "OPEN" }, select: { businessDay: true } });
      if (open) {
        const day = dayKey(open.businessDay);
        throw new DrawerError(day === today ? "The drawer is already open." : `The drawer for ${day} is still open — count and close it first.`, 409);
      }
      const existing = await tx.cashDrawer.findUnique({ where: { walletId_businessDay: { walletId, businessDay } }, select: { id: true } });
      if (existing) throw new DrawerError("Today's drawer has already been counted and closed.", 409);

      const lastClosed = await tx.cashDrawer.findFirst({ where: { walletId, status: "CLOSED" }, orderBy: { businessDay: "desc" }, select: { closingCount: true } });
      const note = input.note?.trim() || null;
      if (lastClosed?.closingCount && toPaisa(lastClosed.closingCount) !== toPaisa(input.openingCount) && !note) {
        throw new DrawerError(`The count differs from the last close (৳ ${fromPaisa(toPaisa(lastClosed.closingCount))}) — add a note saying why.`);
      }
      const [wallet] = await getWalletBalances(tx, { walletId });

      const drawer = await tx.cashDrawer.create({
        data: {
          walletId,
          businessDay,
          openingCount: input.openingCount,
          openingDenominations: input.denominations ?? Prisma.JsonNull,
          openingNote: note,
          bookBalanceAtOpen: wallet?.balance ?? 0,
          openedById: user.id,
        },
      });
      await writeAuditLogWith(tx, {
        actorId: user.id,
        action: "pos.drawer.open",
        entityType: "cash_drawer",
        entityId: drawer.id,
        after: { businessDay: today, walletId, openingCount: input.openingCount, note, bookBalanceAtOpen: wallet?.balance ?? null, lastClosingCount: lastClosed?.closingCount?.toString() ?? null },
      });
      return drawer.id;
    });
    return (await getDrawerSummary(db, drawerId))!;
  } catch (error) {
    // Two tills opening at once: the unique indexes decide, the loser is told.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new DrawerError("The drawer was just opened by someone else — reload.", 409);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Close — count, verify the day's cash, post the difference once
// ---------------------------------------------------------------------------

export type CloseDrawerInput = { drawerId: string; closingCount: number; denominations?: Denominations | null; note?: string | null };

type LockedDrawer = { id: string; walletId: string; businessDay: Date; status: "OPEN" | "CLOSED"; openingCount: Prisma.Decimal };

/**
 * FOR UPDATE on the drawer: a close waits for every in-flight cash sale
 * (which holds FOR SHARE on it, see lockOpenDrawerForSale), and a sale that
 * arrives after the close commits sees it CLOSED and is refused — so no cash
 * payment can slip in between the count and the close.
 */
async function lockDrawer(tx: Prisma.TransactionClient, drawerId: string, mode: "UPDATE" | "SHARE"): Promise<LockedDrawer | null> {
  const rows =
    mode === "UPDATE"
      ? await tx.$queryRaw<LockedDrawer[]>`SELECT "id", "walletId", "businessDay", "status", "openingCount" FROM "cash_drawers" WHERE "id" = ${drawerId} FOR UPDATE`
      : await tx.$queryRaw<LockedDrawer[]>`SELECT "id", "walletId", "businessDay", "status", "openingCount" FROM "cash_drawers" WHERE "id" = ${drawerId} FOR SHARE`;
  return rows[0] ?? null;
}

export async function closeDrawer(db: Db, user: SessionUser, input: CloseDrawerInput): Promise<DrawerSummary> {
  await withTx(db, async (tx) => {
    const drawer = await lockDrawer(tx, input.drawerId, "UPDATE");
    if (!drawer) throw new DrawerError("Drawer not found", 404);
    if (drawer.status !== "OPEN") throw new DrawerError("This drawer is already closed.", 409);

    const flows = await loadFlows(tx, drawer, null);
    const expected = expectedPaisa(drawer.openingCount, flows);
    const counted = toPaisa(input.closingCount);
    const difference = counted - expected;
    const note = input.note?.trim() || null;
    if (difference !== 0 && !note) {
      throw new DrawerError(`The count is ${difference < 0 ? "short" : "over"} by ৳ ${fromPaisa(Math.abs(difference))} — add a note saying what happened.`);
    }
    const now = new Date();

    // The count is the proof the day's cash is here: verify it.
    if (flows.unverifiedIds.length > 0) {
      const verifiable = await tx.payment.findMany({
        where: { id: { in: flows.unverifiedIds }, verified: false },
        select: { id: true, orderId: true, amount: true, method: true, walletId: true, transactionId: true },
      });
      await tx.payment.updateMany({ where: { id: { in: verifiable.map((p) => p.id) }, verified: false }, data: { verified: true, verifiedById: user.id, verifiedAt: now } });
      for (const p of verifiable) {
        await writeAuditLogWith(tx, {
          actorId: user.id,
          action: "payment.verify",
          entityType: "order",
          entityId: p.orderId,
          before: { paymentId: p.id, verified: false },
          after: { paymentId: p.id, verified: true, amount: p.amount.toString(), method: p.method, walletId: p.walletId, transactionId: p.transactionId, via: "cash_drawer_close", drawerId: drawer.id },
        });
      }
    }

    // The difference reaches the wallet and P&L once, under its own heading.
    let expenseId: string | null = null;
    if (difference !== 0) {
      const expense = await tx.expense.create({
        data: {
          expenseDate: drawer.businessDay,
          categoryId: CASH_OVER_SHORT_CATEGORY_ID,
          nature: "VARIABLE",
          amount: fromPaisa(-difference),
          walletId: drawer.walletId,
          note: `${difference < 0 ? "Cash short" : "Cash over"} ৳ ${fromPaisa(Math.abs(difference))} at the ${dayKey(drawer.businessDay)} drawer count — ${note}`,
          cashDrawerId: drawer.id,
          createdById: user.id,
        },
      });
      expenseId = expense.id;
    }

    const closed = await tx.cashDrawer.updateMany({
      where: { id: drawer.id, status: "OPEN" },
      data: {
        status: "CLOSED",
        closedAt: now,
        closedById: user.id,
        closingCount: fromPaisa(counted),
        closingDenominations: input.denominations ?? Prisma.JsonNull,
        expectedClose: fromPaisa(expected),
        difference: fromPaisa(difference),
        closeNote: note,
      },
    });
    if (closed.count !== 1) throw new DrawerError("This drawer is already closed.", 409);

    await writeAuditLogWith(tx, {
      actorId: user.id,
      action: "pos.drawer.close",
      entityType: "cash_drawer",
      entityId: drawer.id,
      before: { status: "OPEN", openingCount: drawer.openingCount.toString() },
      after: {
        status: "CLOSED",
        businessDay: dayKey(drawer.businessDay),
        expectedClose: fromPaisa(expected),
        closingCount: fromPaisa(counted),
        difference: fromPaisa(difference),
        note,
        overShortExpenseId: expenseId,
        verifiedPaymentIds: flows.unverifiedIds,
      },
    });
  });
  return (await getDrawerSummary(db, input.drawerId))!;
}

/**
 * The drawer a cash sale goes into: today's, open. Taken FOR SHARE so the
 * sale and a concurrent close serialize (see lockDrawer).
 */
export async function lockOpenDrawerForSale(tx: Prisma.TransactionClient, walletId: string): Promise<{ id: string }> {
  const today = todayInDhaka();
  const drawer = await tx.cashDrawer.findUnique({ where: { walletId_businessDay: { walletId, businessDay: dhakaDayStartUtc(today) } }, select: { id: true } });
  const locked = drawer ? await lockDrawer(tx, drawer.id, "SHARE") : null;
  if (!locked) throw new DrawerError("Open today's cash drawer before taking cash.", 409);
  if (locked.status !== "OPEN") throw new DrawerError("Today's cash drawer is closed — cash can't be taken until tomorrow's opens. Card, bKash and Nagad still work.", 409);
  return { id: locked.id };
}

// ---------------------------------------------------------------------------
// Cash in / out during the day
// ---------------------------------------------------------------------------

export type DrawerMovementInput = { kind: DrawerMovementKind; amount: number; note: string; toWalletId?: string | null; categoryId?: string | null };

/**
 * Records cash leaving (or entering) the drawer through the same services
 * the wallet and expense screens use — so it is a normal wallet entry,
 * transfer or expense, audit-logged there, and shows in the day's flows.
 */
export async function recordDrawerMovement(db: Db, user: SessionUser, walletId: string, input: DrawerMovementInput): Promise<DrawerSummary> {
  const today = todayInDhaka();
  const businessDay = dhakaDayStartUtc(today);
  const drawerId = await withTx(db, async (tx) => {
    const drawer = await tx.cashDrawer.findUnique({ where: { walletId_businessDay: { walletId, businessDay } }, include: drawerInclude });
    if (!drawer || drawer.status !== "OPEN") throw new DrawerError("Open today's cash drawer first.", 409);
    const locked = await lockDrawer(tx, drawer.id, "SHARE");
    if (!locked || locked.status !== "OPEN") throw new DrawerError("Today's drawer is closed.", 409);

    if (input.kind !== "CASH_IN") {
      const inDrawer = expectedPaisa(drawer.openingCount, await loadFlows(tx, drawer, null));
      if (toPaisa(input.amount) > inDrawer) throw new DrawerError(`The drawer should only hold ৳ ${fromPaisa(inDrawer)} — you can't take out more than that.`);
    }

    switch (input.kind) {
      case "DEPOSIT":
        if (!input.toWalletId) throw new DrawerError("Pick the wallet the cash went to.");
        await createTransfer(tx, { fromWalletId: walletId, toWalletId: input.toWalletId, amount: input.amount, entryDate: businessDay, note: input.note }, user.id);
        break;
      case "EXPENSE": {
        if (!input.categoryId) throw new DrawerError("Pick what the expense was for.");
        const category = await tx.expenseCategory.findUnique({ where: { id: input.categoryId }, select: { defaultNature: true } });
        if (!category) throw new DrawerError("Pick what the expense was for.");
        await createExpense(tx, { expenseDate: businessDay, categoryId: input.categoryId, nature: category.defaultNature, amount: input.amount, walletId, note: input.note }, user.id);
        break;
      }
      case "CASH_OUT":
        await createManualEntry(tx, { walletId, direction: "OUT", amount: input.amount, entryDate: businessDay, note: input.note }, user.id);
        break;
      case "CASH_IN":
        await createManualEntry(tx, { walletId, direction: "IN", amount: input.amount, entryDate: businessDay, note: input.note }, user.id);
        break;
    }
    return drawer.id;
  });
  return (await getDrawerSummary(db, drawerId))!;
}
