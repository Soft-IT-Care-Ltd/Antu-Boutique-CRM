import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { recordJobRun, rejectUnlessCron } from "@/lib/system/jobs";

// PRD §4.18 — scripts/backup.sh runs pg_dump outside the app (so a broken app
// can't stop the backup) and reports each run here, success or failure.
// Settings shows the latest; the app shell warns an admin once the last good
// one is over 48 hours old. Machine-to-machine: Bearer <CRON_SECRET>.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const name = z.string().trim().min(1).max(200).regex(/^[\w.\-]+$/, "A bare file name");
const reportSchema = z
  .object({
    ok: z.boolean(),
    startedAt: z.coerce.date(),
    finishedAt: z.coerce.date(),
    host: z.string().trim().max(100).optional(),
    file: name.optional(),
    sizeBytes: z.number().int().min(0).optional(),
    uploadsFile: name.optional(),
    uploadsBytes: z.number().int().min(0).optional(),
    offsite: z.enum(["copied", "failed", "off"]).optional(),
    pruned: z.number().int().min(0).optional(),
    kept: z.number().int().min(0).optional(),
    error: z.string().trim().max(2000).optional(),
  })
  .refine((r) => r.finishedAt >= r.startedAt, "finishedAt is before startedAt")
  .refine((r) => r.finishedAt.getTime() <= Date.now() + 5 * 60_000, "finishedAt is in the future")
  .refine((r) => !r.ok || (r.file && r.sizeBytes && r.sizeBytes > 0), "A successful backup names its dump file and size")
  .refine((r) => r.ok || r.error, "A failed backup says why");

export async function POST(request: NextRequest) {
  const unauthorized = rejectUnlessCron(request);
  if (unauthorized) return unauthorized;
  const parsed = reportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid report" }, { status: 400 });
  const { ok, startedAt, finishedAt, error, ...summary } = parsed.data;
  await recordJobRun(prisma, { job: "backup", ok, startedAt, finishedAt, summary, error });
  return NextResponse.json({ ok: true });
}
