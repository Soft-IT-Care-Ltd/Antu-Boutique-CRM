import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { rejectUnlessCron } from "@/lib/system/jobs";
import { evaluateLastMonthIfDue } from "@/lib/targets/rewards";

// PRD §4.13 "auto-evaluated at month end". Works out last month's rewards
// the first time it runs in a new month, then does nothing until the next
// one — so a daily schedule is enough and a missed day catches up.
// Machine-to-machine: "Authorization: Bearer <CRON_SECRET>", no session.
//
//   15 0 * * * curl -fsS -m 60 -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/rewards
//   (00:15 server time; the month boundary is Dhaka's)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const unauthorized = rejectUnlessCron(request);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json({ ok: true, ...(await evaluateLastMonthIfDue(prisma)) });
  } catch (error) {
    console.error("Month-end reward evaluation failed:", error);
    return NextResponse.json({ ok: false, error: "Evaluation failed" }, { status: 500 });
  }
}
