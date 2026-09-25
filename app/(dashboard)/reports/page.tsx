import Link from "next/link";
import { ChevronRight, ScrollText, TrendingUp } from "lucide-react";

import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { runnableReports } from "@/lib/reports/access";
import { REPORT_BY_KEY, REPORT_KEYS } from "@/lib/reports/catalog";

// P4.4 (PRD §4.15) — the reports this user may run. A report is listed
// only when its module's own permission allows it (lib/reports/access.ts);
// the numbers inside are scoped to what the user can see.
export default async function ReportsPage() {
  const user = await guardPage("/reports");
  const [keys, canProfit, canAudit] = await Promise.all([runnableReports(user, REPORT_KEYS), can(user, ["report.pl.view", "product.cost.view"], "all"), can(user, "audit.view")]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">Pick a report, set the dates and filters, then export it as CSV or PDF.</p>
      </div>

      {keys.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No reports are available to your role.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {keys.map((k) => {
            const r = REPORT_BY_KEY[k];
            return (
              <Link key={k} href={`/reports/${k}`} className="group flex items-start gap-3 rounded-xl border bg-card p-3 transition-colors hover:bg-muted/40 sm:p-4">
                <span className="mt-0.5 w-9 shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-center font-mono text-xs font-medium">{r.code}</span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-medium">{r.title}</span>
                  <span className="text-sm text-muted-foreground">{r.description}</span>
                </span>
                <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
              </Link>
            );
          })}
        </div>
      )}

      {canProfit || canAudit ? (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {canProfit ? (
            <Link href="/reports/profit" className="flex items-start gap-3 rounded-xl border bg-card p-3 transition-colors hover:bg-muted/40 sm:p-4">
              <TrendingUp className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">Profit breakdown</span>
                <span className="text-sm text-muted-foreground">Order by order: what went out in a period, its revenue and frozen cost.</span>
              </span>
            </Link>
          ) : null}
          {canAudit ? (
            <Link href="/audit-log" className="flex items-start gap-3 rounded-xl border bg-card p-3 transition-colors hover:bg-muted/40 sm:p-4">
              <ScrollText className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">Audit log</span>
                <span className="text-sm text-muted-foreground">Every sensitive change: who, what, before and after.</span>
              </span>
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
