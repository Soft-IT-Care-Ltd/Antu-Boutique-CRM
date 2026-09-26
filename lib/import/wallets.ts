import "server-only";

import type { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import type { CsvTable } from "@/lib/import/csv";
import type { ImportIssue, ImportSummaryItem } from "@/lib/import/types";
import { nameKey, readDay, readMoney } from "@/lib/import/values";
import { dhakaDayStartUtc, todayInDhaka } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { WALLET_TYPE_LABELS, WALLET_TYPE_VALUES, type WalletTypeValue } from "@/lib/wallets/constants";
import { createWallet, updateWallet } from "@/lib/wallets/service";

// PRD §4.10 — each wallet's opening balance and the day it was counted
// (P2.3: a balance is derived from opening balance + everything dated on or
// after the opening date). A name that matches a wallet updates it through
// the same audited service the Wallets screen uses; a new name adds one.

type PlannedWallet = {
  line: number;
  existingId: string | null;
  name: string;
  type: WalletTypeValue;
  accountNo: string | null;
  openingBalance: string;
  openingDay: string;
  note: string | null;
  before: { openingBalance: string; openingDay: string } | null;
};

export type WalletPlan = { wallets: PlannedWallet[]; errors: ImportIssue[]; warnings: ImportIssue[] };

function readWalletType(raw: string): WalletTypeValue {
  const key = nameKey(raw).replace(/[\s_-]/g, "");
  const hit = WALLET_TYPE_VALUES.find((t) => t.toLowerCase() === key || nameKey(WALLET_TYPE_LABELS[t]).replace(/\s/g, "") === key);
  if (!hit) throw new Error(`type "${raw}" — use bKash, Nagad, Rocket, Bank or Cash`);
  return hit;
}

export async function planWalletImport(db: Prisma.TransactionClient, table: CsvTable): Promise<WalletPlan> {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  for (const col of ["wallet_name", "type", "opening_balance", "opening_date"]) {
    if (!table.headers.includes(col)) errors.push({ line: null, message: `The sheet needs a "${col}" column` });
  }
  if (errors.length > 0) return { wallets: [], errors, warnings };

  const existing = await db.wallet.findMany({ select: { id: true, name: true, type: true, openingBalance: true, openingDate: true, _count: { select: { payments: true } } } });
  const today = todayInDhaka();
  const wallets: PlannedWallet[] = [];
  const seen = new Map<string, number>();
  for (const row of table.rows) {
    try {
      const name = (row.values.wallet_name ?? "").trim();
      if (name.length < 2 || name.length > 60) throw new Error("wallet_name must be 2–60 characters");
      const twice = seen.get(nameKey(name));
      if (twice !== undefined) throw new Error(`"${name}" is also on row ${twice}`);
      seen.set(nameKey(name), row.line);
      const type = readWalletType(row.values.type ?? "");
      const openingBalance = readMoney(row.values.opening_balance, "opening_balance", { min: -100_000_000 });
      if (openingBalance === null) throw new Error("opening_balance is blank — write 0 for an empty wallet");
      const openingDay = readDay(row.values.opening_date, "opening_date");
      if (!openingDay) throw new Error("opening_date is blank");
      if (openingDay > today) throw new Error("opening_date is in the future — use the day the balance was counted");
      const accountNo = (row.values.account_no ?? "").trim() || null;
      if (accountNo && accountNo.length > 60) throw new Error("account_no is longer than 60 characters");
      const note = (row.values.note ?? "").trim() || null;
      if (note && note.length > 300) throw new Error("note is longer than 300 characters");

      const match = existing.find((w) => nameKey(w.name) === nameKey(name)) ?? null;
      if (match && match.type !== type && match._count.payments > 0) throw new Error(`${match.name} already has payments — its type can't change from ${WALLET_TYPE_LABELS[match.type]}`);
      if (match && match._count.payments > 0) warnings.push({ line: row.line, message: `${match.name} already has payments — changing its opening balance or date moves its balance and statements` });
      wallets.push({
        line: row.line,
        existingId: match?.id ?? null,
        name: match?.name ?? name,
        type,
        accountNo,
        openingBalance,
        openingDay,
        note,
        before: match ? { openingBalance: match.openingBalance.toFixed(2), openingDay: match.openingDate.toISOString() } : null,
      });
    } catch (e) {
      errors.push({ line: row.line, message: (e as Error).message });
    }
  }
  return { wallets, errors, warnings };
}

export function summarizeWalletPlan(plan: WalletPlan): { summary: ImportSummaryItem[]; preview: { line: number; text: string }[] } {
  const total = plan.wallets.reduce((n, w) => n + Math.round(Number(w.openingBalance) * 100), 0);
  return {
    summary: [
      { label: "Wallets updated", value: String(plan.wallets.filter((w) => w.existingId).length) },
      { label: "Wallets added", value: String(plan.wallets.filter((w) => !w.existingId).length) },
      { label: "Opening balances in total", value: formatBDT(total / 100) },
    ],
    preview: plan.wallets.map((w) => ({
      line: w.line,
      text: `${w.existingId ? "Update" : "Add"} ${w.name} (${WALLET_TYPE_LABELS[w.type]}) — ${formatBDT(w.openingBalance)} counted ${w.openingDay}${w.before ? ` (was ${formatBDT(w.before.openingBalance)})` : ""}`,
    })),
  };
}

export async function applyWalletPlan(tx: Prisma.TransactionClient, plan: WalletPlan, actorId: string, request?: Request): Promise<void> {
  for (const w of plan.wallets) {
    const input = { name: w.name, type: w.type, accountNo: w.accountNo, openingBalance: Number(w.openingBalance), openingDate: dhakaDayStartUtc(w.openingDay), note: w.note };
    if (w.existingId) await updateWallet(tx, w.existingId, input, actorId);
    else await createWallet(tx, input, actorId);
  }
  await writeAuditLogWith(tx, {
    actorId,
    action: "import.wallets",
    entityType: "import",
    entityId: `wallets-${Date.now()}`,
    after: { wallets: plan.wallets.map((w) => ({ name: w.name, openingBalance: w.openingBalance, openingDay: w.openingDay, updated: Boolean(w.existingId) })) },
    request,
  });
}
