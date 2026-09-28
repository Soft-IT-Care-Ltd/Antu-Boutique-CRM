import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { ReportFilterBar } from "@/components/reports/report-filters";
import { ReportView } from "@/components/reports/report-view";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { readPageParams } from "@/lib/list/pagination";
import { getListPageSize } from "@/lib/list/prefs";
import { prisma } from "@/lib/prisma";
import { canRunReport, reach, reportLevel } from "@/lib/reports/access";
import { isReportKey, REPORT_BY_KEY } from "@/lib/reports/catalog";
import { filterOptions, filtersToQuery, parseReportRequest } from "@/lib/reports/filters";
import { formatPeriod } from "@/lib/reports/format";
import { runReport } from "@/lib/reports/run";

export const dynamic = "force-dynamic";

// P4.4 (PRD §4.15) — one screen for every report R1–R14 and the P&L. The
// numbers come from runReport(), the same call the JSON route and both
// exports make, so screen, CSV and PDF always match.
export default async function ReportPage({ params, searchParams }: { params: Promise<{ report: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await guardPage("/reports");
  const { report: key } = await params;
  if (!isReportKey(key)) notFound();
  if (!(await canRunReport(user, key))) redirect("/reports");

  const def = REPORT_BY_KEY[key];
  const query = await searchParams;
  const parsed = await parseReportRequest(prisma, def, query, { lenient: true });
  if (!parsed.ok) notFound();
  const filters = parsed.filters;
  const level = await reportLevel(user, key);
  const [report, options, canExport, savedPageSize] = await Promise.all([
    runReport(prisma, user, key, filters),
    filterOptions(prisma, user, def, level, reach(user, level)),
    can(user, "report.export"),
    getListPageSize(prisma, user.id, "report"),
  ]);
  // CORRECTIONS.md item 15 — each table pages on its own (`page_<table id>`), one page size for the screen.
  const { pageSize } = readPageParams(query, savedPageSize);
  const pages = Object.fromEntries(report.tables.map((t) => [t.id, readPageParams({ page: query[`page_${t.id}`] }, pageSize).page]));

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-col gap-1">
        <Link href="/reports" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> Reports
        </Link>
        <h1 className="text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">
          <span className="mr-2 font-mono text-base font-medium text-muted-foreground">{def.code}</span>
          {def.title}
        </h1>
        <p className="text-sm text-muted-foreground">
          {def.description} <span className="whitespace-nowrap">· {formatPeriod(report.period)}</span>
        </p>
      </div>
      <ReportFilterBar def={def} filters={filters} options={options} exportQuery={canExport ? new URLSearchParams(filtersToQuery(filters)).toString() : null} />
      <ReportView report={report} paging={{ pageSize, pages }} />
    </div>
  );
}
