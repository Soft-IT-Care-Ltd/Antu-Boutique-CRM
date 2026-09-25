import "server-only";

import { can } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/types";
import type { Db } from "@/lib/db/tx";
import { buildCustomersReport } from "@/lib/reports/builders/customers";
import { buildCollectionsReport, buildCourierReport, buildExchangesReport, buildExpenseReport } from "@/lib/reports/builders/money";
import { buildAttendanceReport, buildLeadsReport, buildTeamReport } from "@/lib/reports/builders/people";
import { buildPlReport } from "@/lib/reports/builders/pl";
import { buildCancellationsReport, buildChannelReport, buildSalesReport } from "@/lib/reports/builders/sales";
import { buildSetsReport, buildStockReport } from "@/lib/reports/builders/stock";
import { canRunReport, reach, reportLevel } from "@/lib/reports/access";
import { REPORT_BY_KEY, type ReportKey } from "@/lib/reports/catalog";
import { finalizeReport } from "@/lib/reports/finalize";
import { appliedFilters, type ReportFilters } from "@/lib/reports/filters";
import type { BuildContext, BuiltReport } from "@/lib/reports/shared";
import type { ReportResult } from "@/lib/reports/types";

// The one way a report is produced — for the screen, the JSON route and
// both exports — so they can never disagree: the access check, the scope
// (inside each builder), then the cost strip (CLAUDE.md rule 5).

const BUILDERS: Record<ReportKey, (ctx: BuildContext) => Promise<BuiltReport>> = {
  sales: buildSalesReport,
  leads: buildLeadsReport,
  team: buildTeamReport,
  stock: buildStockReport,
  sets: buildSetsReport,
  courier: buildCourierReport,
  collections: buildCollectionsReport,
  expense: buildExpenseReport,
  pl: buildPlReport,
  attendance: buildAttendanceReport,
  cancellations: buildCancellationsReport,
  customers: buildCustomersReport,
  exchanges: buildExchangesReport,
  channels: buildChannelReport,
};

export class ReportAccessError extends Error {
  constructor() {
    super("Forbidden");
  }
}

export async function runReport(db: Db, user: SessionUser, key: ReportKey, filters: ReportFilters, now = new Date()): Promise<ReportResult> {
  if (!(await canRunReport(user, key))) throw new ReportAccessError();
  const def = REPORT_BY_KEY[key];
  const [level, canSeeCost] = await Promise.all([reportLevel(user, key), can(user, "product.cost.view")]);
  const applied = await appliedFilters(db, user, def, level, reach(user, level), filters);
  const built = await BUILDERS[key]({ db, user, filters, level, canSeeCost, now });
  const result: ReportResult = {
    key,
    code: def.code,
    title: def.title,
    period: built.period === undefined ? { fromDay: filters.fromDay, toDay: filters.toDay } : built.period,
    applied,
    figures: built.figures,
    tables: built.tables,
    notes: built.notes,
    generatedAt: now.toISOString(),
  };
  return finalizeReport(result, canSeeCost);
}
