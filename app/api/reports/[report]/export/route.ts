import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { isReportKey, REPORT_BY_KEY } from "@/lib/reports/catalog";
import { reportFileName, reportToCsv, reportToPdf } from "@/lib/reports/export";
import { parseReportRequest } from "@/lib/reports/filters";
import { ReportAccessError, runReport } from "@/lib/reports/run";

// P4.4 (PRD §4.15) — CSV and PDF export. Needs report.export on top of
// being able to run the report, and is built from the very same
// runReport() result as the screen: same scope, same cost stripping.

const formatSchema = z.enum(["csv", "pdf"]);

export async function GET(request: NextRequest, { params }: { params: Promise<{ report: string }> }) {
  const guard = await requirePermission(["report.view", "report.export"], "all");
  if (!guard.ok) return guard.response;
  const { report } = await params;
  if (!isReportKey(report)) return NextResponse.json({ error: "Report not found" }, { status: 404 });

  const search = Object.fromEntries(request.nextUrl.searchParams);
  const format = formatSchema.safeParse(search.format);
  if (!format.success) return NextResponse.json({ error: "Choose csv or pdf" }, { status: 400 });
  const parsed = await parseReportRequest(prisma, REPORT_BY_KEY[report], search);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  let result;
  try {
    result = await runReport(prisma, guard.user, report, parsed.filters);
  } catch (error) {
    if (error instanceof ReportAccessError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw error;
  }

  if (format.data === "csv") {
    return new NextResponse(reportToCsv(result), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${reportFileName(result, "csv")}"`, "Cache-Control": "no-store" },
    });
  }
  try {
    const pdf = await reportToPdf(result);
    return new NextResponse(Buffer.from(pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${reportFileName(result, "pdf")}"`, "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error(`Failed to render the ${report} report PDF:`, error);
    return NextResponse.json({ error: "Could not make the PDF right now — try again, or export CSV." }, { status: 503 });
  }
}
