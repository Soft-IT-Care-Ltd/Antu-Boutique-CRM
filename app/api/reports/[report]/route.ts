import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { isReportKey, REPORT_BY_KEY } from "@/lib/reports/catalog";
import { parseReportFilters } from "@/lib/reports/filters";
import { ReportAccessError, runReport } from "@/lib/reports/run";

// P4.4 (PRD §4.15) — any report R1–R14 as JSON. report.view gates the
// section; runReport checks the report's own module permission, scopes the
// data to the user and strips cost columns without product.cost.view.
export async function GET(request: NextRequest, { params }: { params: Promise<{ report: string }> }) {
  const guard = await requirePermission("report.view");
  if (!guard.ok) return guard.response;
  const { report } = await params;
  if (!isReportKey(report)) return NextResponse.json({ error: "Report not found" }, { status: 404 });

  const parsed = parseReportFilters(REPORT_BY_KEY[report], Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    return NextResponse.json({ report: await runReport(prisma, guard.user, report, parsed.filters) });
  } catch (error) {
    if (error instanceof ReportAccessError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw error;
  }
}
