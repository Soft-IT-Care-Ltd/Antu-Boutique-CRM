import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { can } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/require-permission";
import { dayRange, dayString } from "@/lib/finance/http";
import { LEAD_SOURCE_VALUES } from "@/lib/leads/constants";
import { badRequest, LEAD_VIEW_PERMISSIONS } from "@/lib/leads/http";
import { conversionReportCsv, getLeadConversionReport } from "@/lib/leads/report";
import { prisma } from "@/lib/prisma";

// PRD §4.5 conversion rate per executive, source and campaign — scoped to
// the caller's own/team/all leads. CSV export needs report.export and gives
// exactly the numbers on screen.
const querySchema = z.object({
  from: dayString.optional(),
  to: dayString.optional(),
  ownerId: z.string().cuid().optional(),
  source: z.enum(LEAD_SOURCE_VALUES).optional(),
  format: z.enum(["json", "csv"]).default("json"),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission(LEAD_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  const { from, to, ownerId, source, format } = parsed.data;
  const range = dayRange(from, to);
  if (range.toDay < range.fromDay) return NextResponse.json({ error: "The end date is before the start date" }, { status: 400 });

  const report = await getLeadConversionReport(prisma, guard.user, { fromDay: range.fromDay, toDay: range.toDay, ownerId, source });
  if (format === "csv") {
    if (!(await can(guard.user, "report.export"))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return new NextResponse(conversionReportCsv(report), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="lead-conversion-${range.fromDay}-to-${range.toDay}.csv"`,
      },
    });
  }
  return NextResponse.json({ report });
}
