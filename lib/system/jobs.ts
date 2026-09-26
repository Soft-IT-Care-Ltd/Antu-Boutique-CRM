import "server-only";

import type { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";

import { timingSafeEqual } from "@/lib/courier/crypto";
import type { Db } from "@/lib/db/tx";
import { backupHealth, JOB_NAMES, type BackupHealth, type JobName } from "@/lib/system/job-status";

// PRD §4.18 / §7 background jobs. Each scheduled run leaves a job_runs row so
// Settings can show when it last ran and whether it worked — the trash
// purge and low-stock alert record themselves from their cron routes, the
// backup is reported by scripts/backup.sh (it runs outside the app, so a
// broken app can't stop the database being backed up).

/**
 * Machine-to-machine auth for /api/cron/*: "Authorization: Bearer
 * <CRON_SECRET>", no session. Fails closed when CRON_SECRET is unset.
 * Returns the 401 to send, or null when the caller is the scheduler.
 */
export function rejectUnlessCron(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET?.trim();
  const presented = request.headers.get("authorization") ?? "";
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function recordJobRun(
  db: Db,
  run: { job: JobName; ok: boolean; startedAt: Date; finishedAt?: Date; summary?: unknown; error?: string | null },
): Promise<void> {
  await db.jobRun.create({
    data: {
      job: run.job,
      ok: run.ok,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? new Date(),
      summary: run.summary === undefined ? undefined : (run.summary as Prisma.InputJsonValue),
      error: run.ok ? null : (run.error?.trim() || "Failed"),
    },
  });
}

/** Runs a job, records how it went (success or failure) and returns the outcome. */
export async function runRecordedJob<T>(db: Db, job: JobName, fn: () => Promise<T>): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  const startedAt = new Date();
  try {
    const result = await fn();
    await recordJobRun(db, { job, ok: true, startedAt, summary: result });
    return { ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Job ${job} failed:`, error);
    await recordJobRun(db, { job, ok: false, startedAt, error: message.slice(0, 2000) }).catch((e) => console.error(`Could not record the ${job} failure:`, e));
    return { ok: false, error: message };
  }
}

export type JobRunView = { ok: boolean; startedAt: string; finishedAt: string; summary: unknown; error: string | null };
export type JobStatus = { job: JobName; last: JobRunView | null; lastOk: JobRunView | null };

const view = (r: { ok: boolean; startedAt: Date; finishedAt: Date; summary: Prisma.JsonValue; error: string | null } | null): JobRunView | null =>
  r ? { ok: r.ok, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt.toISOString(), summary: r.summary, error: r.error } : null;

/** The latest run and the latest successful run of every job. */
export async function getJobStatuses(db: Db): Promise<JobStatus[]> {
  return Promise.all(
    JOB_NAMES.map(async (job) => {
      const [last, lastOk] = await Promise.all([
        db.jobRun.findFirst({ where: { job }, orderBy: { finishedAt: "desc" } }),
        db.jobRun.findFirst({ where: { job, ok: true }, orderBy: { finishedAt: "desc" } }),
      ]);
      return { job, last: view(last), lastOk: view(lastOk) };
    }),
  );
}

/** How fresh the last good backup is — one indexed query, cheap enough for the app shell. */
export async function getBackupHealth(db: Db, now = new Date()): Promise<BackupHealth> {
  const [lastOk, anyRun] = await Promise.all([
    db.jobRun.findFirst({ where: { job: "backup", ok: true }, orderBy: { finishedAt: "desc" }, select: { finishedAt: true } }),
    db.jobRun.findFirst({ where: { job: "backup" }, orderBy: { finishedAt: "desc" }, select: { ok: true, finishedAt: true, error: true } }),
  ]);
  return backupHealth(lastOk?.finishedAt ?? null, now, anyRun && !anyRun.ok ? { at: anyRun.finishedAt, error: anyRun.error } : null);
}
