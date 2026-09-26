import { NextResponse, type NextRequest } from "next/server";

import { todayInDhaka } from "@/lib/inventory/constants";
import { sendLowStockAlert } from "@/lib/inventory/low-stock-alert";
import { getLowStockAlerts } from "@/lib/inventory/stock-report";
import { prisma } from "@/lib/prisma";
import { rejectUnlessCron, runRecordedJob } from "@/lib/system/jobs";

// PRD §4.18 / §7 — the daily low-stock alert: one in-app notification per
// stock buyer, once a Dhaka day (a second run the same day sends nothing).
// Machine-to-machine: "Authorization: Bearer <CRON_SECRET>", no session.
//
//   0 3 * * * curl -fsS -m 60 -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/low-stock-alert
//   (03:00 UTC = 09:00 Dhaka, before the shop opens)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const unauthorized = rejectUnlessCron(request);
  if (unauthorized) return unauthorized;
  const run = await runRecordedJob(prisma, "low-stock-alert", async () => sendLowStockAlert(prisma, await getLowStockAlerts(), todayInDhaka()));
  return run.ok ? NextResponse.json({ ok: true, ...run.result }) : NextResponse.json({ ok: false, error: "Low-stock alert failed" }, { status: 500 });
}
