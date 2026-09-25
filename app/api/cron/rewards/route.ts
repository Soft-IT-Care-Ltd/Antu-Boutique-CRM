import { NextResponse, type NextRequest } from "next/server";

import { timingSafeEqual } from "@/lib/courier/crypto";
import { prisma } from "@/lib/prisma";
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
  const secret = process.env.CRON_SECRET?.trim();
  const presented = request.headers.get("authorization") ?? "";
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await evaluateLastMonthIfDue(prisma)) });
  } catch (error) {
    console.error("Month-end reward evaluation failed:", error);
    return NextResponse.json({ ok: false, error: "Evaluation failed" }, { status: 500 });
  }
}
