import "server-only";

import type { Prisma } from "@prisma/client";

import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import type { Db } from "@/lib/db/tx";
import type { ExpenseKindValue, ExpenseNatureValue } from "@/lib/expenses/constants";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import type { OrderChannelValue, PaymentMethodValue } from "@/lib/orders/constants";
import { getStoreCreditPosition, type StoreCreditPosition } from "@/lib/store-credit/ledger";

// P2.3 collection report and expense report, for a Dhaka date range
// [from, to). Money is summed in paisa and returned as "123.45" strings.
// Profit-adjacent: the routes/pages gate them on payment.view / expense.view
// (Admin, Manager, Accounts).

const DHAKA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" });
const dayOf = (d: Date) => DHAKA_DAY.format(d);

function bump<K>(map: Map<K, number>, key: K, paisa: number) {
  map.set(key, (map.get(key) ?? 0) + paisa);
}

// ---------------------------------------------------------------------------
// Collection report
// ---------------------------------------------------------------------------

export type CollectionReport = {
  from: string;
  to: string;
  totals: { collected: string; verified: string; unverified: string; refunds: string; net: string; paymentCount: number; refundCount: number };
  byMethod: { method: PaymentMethodValue; count: number; collected: string; refunds: string }[];
  byWallet: { walletId: string | null; label: string; collected: string; refunds: string; net: string }[];
  byDay: { day: string; collected: string; refunds: string; net: string }[];
  byStaff: { name: string; count: number; collected: string }[];
  /** P3.1 — Online vs Walk-in (PRD §4.15 R14). */
  byChannel: { channel: OrderChannelValue; count: number; collected: string; refunds: string; net: string }[];
  /**
   * P3.2 — store credit is a liability, not money collected: it moves no
   * cash, so none of the figures above include it. `outstanding` is what the
   * shop owed customers at the end of the period (whole shop — a balance
   * isn't tied to one channel or executive); what moved in the period
   * follows the channel filter.
   */
  storeCredit: StoreCreditPosition;
};

export async function getCollectionReport(db: Db, user: SessionUser, from: Date, to: Date, channel?: OrderChannelValue): Promise<CollectionReport> {
  const orderWhere: Prisma.OrderWhereInput = channel ? { deletedAt: null, channel } : { deletedAt: null };
  const rows = await db.payment.findMany({
    where: {
      paidAt: { gte: from, lt: to },
      // The channel narrows inside the scope; it can never widen it (CLAUDE.md rule 6).
      order: scopedWhere(orderWhere, user) as Prisma.OrderWhereInput,
      OR: [{ kind: "PAYMENT" }, { kind: "REFUND", refundStatus: "APPROVED" }],
    },
    select: {
      kind: true,
      amount: true,
      method: true,
      verified: true,
      paidAt: true,
      walletId: true,
      wallet: { select: { name: true } },
      receivedBy: { select: { name: true } },
      order: { select: { channel: true } },
    },
  });

  let collected = 0;
  let verified = 0;
  let refunds = 0;
  let paymentCount = 0;
  let refundCount = 0;
  const method = new Map<PaymentMethodValue, { count: number; collected: number; refunds: number }>();
  const walletIn = new Map<string, number>();
  const walletOut = new Map<string, number>();
  const walletLabel = new Map<string, { walletId: string | null; label: string }>();
  const dayIn = new Map<string, number>();
  const dayOut = new Map<string, number>();
  const staff = new Map<string, { count: number; paisa: number }>();
  const byChannel = new Map<OrderChannelValue, { count: number; in: number; out: number }>();

  for (const r of rows) {
    const paisa = toPaisa(r.amount);
    const ch = byChannel.get(r.order.channel) ?? { count: 0, in: 0, out: 0 };
    if (r.kind === "REFUND") ch.out -= paisa;
    else {
      ch.count += 1;
      ch.in += paisa;
    }
    byChannel.set(r.order.channel, ch);
    const m = method.get(r.method) ?? { count: 0, collected: 0, refunds: 0 };
    const walletKey = r.walletId ?? (r.method === "COURIER_COD" ? "__courier" : "__none");
    walletLabel.set(walletKey, { walletId: r.walletId, label: r.wallet?.name ?? (r.method === "COURIER_COD" ? "Via courier payout" : "No wallet recorded") });
    if (r.kind === "REFUND") {
      refunds -= paisa;
      refundCount += 1;
      m.refunds -= paisa;
      bump(walletOut, walletKey, -paisa);
      bump(dayOut, dayOf(r.paidAt), -paisa);
    } else {
      collected += paisa;
      paymentCount += 1;
      if (r.verified) verified += paisa;
      m.count += 1;
      m.collected += paisa;
      bump(walletIn, walletKey, paisa);
      bump(dayIn, dayOf(r.paidAt), paisa);
      const name = r.receivedBy?.name ?? "—";
      const s = staff.get(name) ?? { count: 0, paisa: 0 };
      s.count += 1;
      s.paisa += paisa;
      staff.set(name, s);
    }
    method.set(r.method, m);
  }

  const days = [...new Set([...dayIn.keys(), ...dayOut.keys()])].sort();
  const storeCredit = await getStoreCreditPosition(db, from, to, channel);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    totals: {
      collected: fromPaisa(collected),
      verified: fromPaisa(verified),
      unverified: fromPaisa(collected - verified),
      refunds: fromPaisa(refunds),
      net: fromPaisa(collected - refunds),
      paymentCount,
      refundCount,
    },
    byMethod: [...method.entries()].map(([k, v]) => ({ method: k, count: v.count, collected: fromPaisa(v.collected), refunds: fromPaisa(v.refunds) })).sort((a, b) => Number(b.collected) - Number(a.collected)),
    byWallet: [...walletLabel.entries()]
      .map(([key, info]) => {
        const inP = walletIn.get(key) ?? 0;
        const outP = walletOut.get(key) ?? 0;
        return { ...info, collected: fromPaisa(inP), refunds: fromPaisa(outP), net: fromPaisa(inP - outP) };
      })
      .sort((a, b) => Number(b.net) - Number(a.net)),
    byDay: days.map((day) => {
      const inP = dayIn.get(day) ?? 0;
      const outP = dayOut.get(day) ?? 0;
      return { day, collected: fromPaisa(inP), refunds: fromPaisa(outP), net: fromPaisa(inP - outP) };
    }),
    byStaff: [...staff.entries()].map(([name, v]) => ({ name, count: v.count, collected: fromPaisa(v.paisa) })).sort((a, b) => Number(b.collected) - Number(a.collected)),
    byChannel: [...byChannel.entries()].map(([ch, v]) => ({ channel: ch, count: v.count, collected: fromPaisa(v.in), refunds: fromPaisa(v.out), net: fromPaisa(v.in - v.out) })),
    storeCredit,
  };
}

// ---------------------------------------------------------------------------
// Expense report
// ---------------------------------------------------------------------------

export type ExpenseReport = {
  from: string;
  to: string;
  total: string;
  count: number;
  byNature: { nature: ExpenseNatureValue; amount: string }[];
  byKind: { kind: ExpenseKindValue; amount: string; categories: { name: string; count: number; amount: string }[] }[];
  byWallet: { walletId: string | null; label: string; amount: string }[];
  byDay: { day: string; amount: string }[];
};

export async function getExpenseReport(db: Db, from: Date, to: Date): Promise<ExpenseReport> {
  const rows = await db.expense.findMany({
    where: { deletedAt: null, expenseDate: { gte: from, lt: to } },
    select: { amount: true, nature: true, expenseDate: true, walletId: true, wallet: { select: { name: true } }, category: { select: { name: true, kind: true } } },
  });

  let total = 0;
  const nature = new Map<ExpenseNatureValue, number>();
  const kind = new Map<ExpenseKindValue, Map<string, { count: number; paisa: number }>>();
  const wallet = new Map<string, { walletId: string | null; label: string; paisa: number }>();
  const day = new Map<string, number>();

  for (const r of rows) {
    const paisa = toPaisa(r.amount);
    total += paisa;
    bump(nature, r.nature, paisa);
    const cats = kind.get(r.category.kind) ?? new Map();
    const c = cats.get(r.category.name) ?? { count: 0, paisa: 0 };
    c.count += 1;
    c.paisa += paisa;
    cats.set(r.category.name, c);
    kind.set(r.category.kind, cats);
    const wKey = r.walletId ?? "__none";
    const w = wallet.get(wKey) ?? { walletId: r.walletId, label: r.wallet?.name ?? "Not from a wallet (deducted by courier / stock write-off)", paisa: 0 };
    w.paisa += paisa;
    wallet.set(wKey, w);
    bump(day, dayOf(r.expenseDate), paisa);
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    total: fromPaisa(total),
    count: rows.length,
    byNature: [...nature.entries()].map(([k, v]) => ({ nature: k, amount: fromPaisa(v) })),
    byKind: [...kind.entries()]
      .map(([k, cats]) => {
        const categories = [...cats.entries()].map(([name, v]) => ({ name, count: v.count, amount: fromPaisa(v.paisa) })).sort((a, b) => Number(b.amount) - Number(a.amount));
        return { kind: k, amount: fromPaisa([...cats.values()].reduce((a, v) => a + v.paisa, 0)), categories };
      })
      .sort((a, b) => Number(b.amount) - Number(a.amount)),
    byWallet: [...wallet.values()].map((w) => ({ walletId: w.walletId, label: w.label, amount: fromPaisa(w.paisa) })).sort((a, b) => Number(b.amount) - Number(a.amount)),
    byDay: [...day.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, v]) => ({ day: d, amount: fromPaisa(v) })),
  };
}
