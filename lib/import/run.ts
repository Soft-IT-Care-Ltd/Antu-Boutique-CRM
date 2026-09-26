import "server-only";

import { withTx, type Db } from "@/lib/db/tx";
import { CsvError, parseCsv, type CsvTable } from "@/lib/import/csv";
import { applyCustomerPlan, planCustomerImport, summarizeCustomerPlan } from "@/lib/import/customers";
import { applyProductPlan, planProductImport, summarizeProductPlan } from "@/lib/import/products";
import type { ImportKind, ImportReport } from "@/lib/import/types";
import { applyWalletPlan, planWalletImport, summarizeWalletPlan } from "@/lib/import/wallets";

// P5.2 — every import is two steps with the same code: a preview that plans
// the whole sheet and reports every problem by row, and a commit that plans
// it again inside one transaction and writes it only if nothing is wrong. A
// sheet is all-or-nothing: fix the rows, upload again. A commit re-plans, so
// anything that changed since the preview is caught, not overwritten.

const PREVIEW_LIMIT = 200;
/** Imports run long (every opening-stock row is a ledger write); nobody else is working at go-live. */
const IMPORT_TX_TIMEOUT_MS = 10 * 60_000;

const ALIASES: Record<ImportKind, Record<string, string>> = {
  products: { code: "product_code", name: "product_name", color: "colour", price: "base_price", selling_price: "base_price", qty: "opening_qty", opening_stock: "opening_qty", stock: "opening_qty", cost: "unit_cost" },
  customers: { customer_name: "name", mobile: "phone", alternate_phone: "alt_phone", address_detail: "address" },
  wallets: { name: "wallet_name", wallet: "wallet_name", balance: "opening_balance", date: "opening_date", account: "account_no" },
};

function applyAliases(kind: ImportKind, table: CsvTable): CsvTable {
  const aliases = ALIASES[kind];
  const rename = (h: string) => (aliases[h] && !table.headers.includes(aliases[h]) ? aliases[h] : h);
  return {
    headers: table.headers.map(rename),
    rows: table.rows.map((r) => ({ line: r.line, values: Object.fromEntries(Object.entries(r.values).map(([k, v]) => [rename(k), v])) })),
  };
}

export async function runImport(db: Db, kind: ImportKind, csvText: string, actorId: string, { commit, request }: { commit: boolean; request?: Request }): Promise<ImportReport> {
  let table: CsvTable;
  try {
    table = applyAliases(kind, parseCsv(csvText));
  } catch (e) {
    if (!(e instanceof CsvError)) throw e;
    return { kind, rows: 0, errors: [{ line: null, message: e.message }], warnings: [], summary: [], preview: [], committed: false };
  }

  return withTx(
    db,
    async (tx) => {
      const report = (planned: { errors: ImportReport["errors"]; warnings: ImportReport["warnings"] }, s: { summary: ImportReport["summary"]; preview: ImportReport["preview"] }): ImportReport => ({
        kind,
        rows: table.rows.length,
        errors: planned.errors,
        warnings: planned.warnings,
        summary: s.summary,
        preview: s.preview.slice(0, PREVIEW_LIMIT),
        committed: false,
      });

      if (kind === "products") {
        const plan = await planProductImport(tx, table);
        const result = report(plan, summarizeProductPlan(plan));
        if (!commit || plan.errors.length > 0) return result;
        await applyProductPlan(tx, plan, actorId, request);
        return { ...result, committed: true };
      }
      if (kind === "customers") {
        const actor = await tx.user.findUniqueOrThrow({ where: { id: actorId }, select: { id: true, name: true, teamId: true } });
        const plan = await planCustomerImport(tx, table, actor);
        const result = report(plan, summarizeCustomerPlan(plan));
        if (!commit || plan.errors.length > 0) return result;
        await applyCustomerPlan(tx, plan, actorId, request);
        return { ...result, committed: true };
      }
      const plan = await planWalletImport(tx, table);
      const result = report(plan, summarizeWalletPlan(plan));
      if (!commit || plan.errors.length > 0) return result;
      await applyWalletPlan(tx, plan, actorId, request);
      return { ...result, committed: true };
    },
    IMPORT_TX_TIMEOUT_MS,
  );
}
