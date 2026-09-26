import { NextResponse, type NextRequest } from "next/server";

import { prisma } from "@/lib/prisma";
import { rejectUnlessCron, runRecordedJob } from "@/lib/system/jobs";
import { purgeTrash } from "@/lib/trash/purge";

// PRD §4.18 — the nightly trash purge: what has been in the trash 30 days is
// deleted, or archived when history still points to it (lib/trash/purge.ts).
// Machine-to-machine: "Authorization: Bearer <CRON_SECRET>", no session.
// Every run is recorded (job_runs) and shown in Settings.
//
//   30 3 * * * curl -fsS -m 300 -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/trash-purge
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const unauthorized = rejectUnlessCron(request);
  if (unauthorized) return unauthorized;
  const run = await runRecordedJob(prisma, "trash-purge", () => purgeTrash(prisma));
  return run.ok ? NextResponse.json({ ok: true, ...run.result }) : NextResponse.json({ ok: false, error: "Purge failed" }, { status: 500 });
}
