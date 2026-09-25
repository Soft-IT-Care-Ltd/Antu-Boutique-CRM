import { stripCostFields } from "@/lib/auth/strip-cost-fields";
import type { ReportResult, ReportRow } from "@/lib/reports/types";

// CLAUDE.md rule 5 at the report layer: without product.cost.view a cost
// column is removed outright — its definition, every row's value and the
// totals line — and so is a cost figure. Hiding it in the UI is not enough;
// the JSON, the CSV and the PDF are all built from what this returns.
//
// stripCostFields runs after it as a second net: any row key that is a
// known cost field name (valueAtCost, margin, profit…) goes too, even if a
// builder forgot to flag its column.

function dropKeys(row: ReportRow, keys: Set<string>): ReportRow {
  const out: ReportRow = {};
  for (const [k, v] of Object.entries(row)) if (!keys.has(k)) out[k] = v;
  return out;
}

export function finalizeReport(result: ReportResult, canSeeCost: boolean): ReportResult {
  if (canSeeCost) return result;
  const stripped: ReportResult = {
    ...result,
    figures: result.figures.filter((f) => !f.costOnly),
    tables: result.tables.map((t) => {
      const hidden = new Set(t.columns.filter((c) => c.costOnly).map((c) => c.key));
      return {
        ...t,
        columns: t.columns.filter((c) => !c.costOnly),
        rows: t.rows.map((r) => dropKeys(r, hidden)),
        ...(t.totals ? { totals: dropKeys(t.totals, hidden) } : {}),
      };
    }),
  };
  return stripCostFields(stripped, false);
}
