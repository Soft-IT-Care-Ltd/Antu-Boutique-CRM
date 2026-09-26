import { AlertTriangle, CheckCircle2, CircleDashed, DatabaseBackup, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import { BACKUP_RETENTION_DAYS, BACKUP_STALE_HOURS, formatAge, JOB_LABELS, type BackupHealth } from "@/lib/system/job-status";
import type { JobStatus } from "@/lib/system/jobs";

// PRD §4.17 "Backup status" / §4.18 — when the nightly jobs last ran and
// whether they worked. The backup is the one that must never go quiet: over
// 48 hours without a good one turns this card (and the admin banner) red.

function formatBytes(n: unknown): string | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown) => (typeof v === "number" ? v : 0);

function backupDetail(summary: unknown): string {
  const s = obj(summary);
  const parts = [
    typeof s.file === "string" ? `${s.file}${formatBytes(s.sizeBytes) ? ` (${formatBytes(s.sizeBytes)})` : ""}` : null,
    typeof s.uploadsFile === "string" ? `photos & files ${formatBytes(s.uploadsBytes) ?? ""}`.trim() : null,
    s.offsite === "copied" ? "copied off the server" : s.offsite === "failed" ? "off-server copy FAILED" : s.offsite === "off" ? "no off-server copy" : null,
    typeof s.kept === "number" ? `${s.kept} kept` : null,
    typeof s.host === "string" ? `on ${s.host}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

function purgeDetail(summary: unknown): string {
  const s = obj(summary);
  const o = obj(s.orders), l = obj(s.leads), c = obj(s.customers), p = obj(s.products), ph = obj(s.orderPhotos);
  const bits = [
    num(o.purged) ? `${num(o.purged)} orders` : null,
    num(l.purged) ? `${num(l.purged)} leads` : null,
    num(c.purged) ? `${num(c.purged)} customers` : null,
    num(p.purged) ? `${num(p.purged)} products` : null,
    num(ph.purged) ? `${num(ph.purged)} order photos` : null,
  ].filter(Boolean);
  const archived = num(c.archived) + num(p.archived);
  const failures = Array.isArray(s.failures) ? s.failures.length : 0;
  return [bits.length ? `Removed ${bits.join(", ")}` : "Nothing was due", archived ? `${archived} archived for the records` : null, failures ? `${failures} problem${failures === 1 ? "" : "s"} — see the audit log` : null]
    .filter(Boolean)
    .join(" · ");
}

function alertDetail(summary: unknown): string {
  const s = obj(summary);
  return num(s.products) ? `${num(s.products)} products low · sent to ${num(s.sent)} of ${num(s.recipients)} people` : "Nothing was low";
}

export function SystemStatusCard({ backup, jobs }: { backup: BackupHealth; jobs: JobStatus[] }) {
  const byJob = Object.fromEntries(jobs.map((j) => [j.job, j]));
  const backupJob = byJob.backup;

  return (
    <Card id="system">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DatabaseBackup className="size-5" />
          Backups &amp; nightly jobs
        </CardTitle>
        <CardDescription>
          The database is dumped every night and each copy kept {BACKUP_RETENTION_DAYS} days. You&apos;ll be warned if the last good backup is more than {BACKUP_STALE_HOURS} hours old.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div
          className={
            backup.state === "ok"
              ? "rounded-lg border border-emerald-600/30 bg-emerald-600/5 p-3"
              : "rounded-lg border border-destructive/40 bg-destructive/5 p-3"
          }
          role={backup.state === "ok" ? undefined : "alert"}
        >
          <div className="flex flex-wrap items-center gap-2">
            {backup.state === "ok" ? <CheckCircle2 className="size-4 text-emerald-600" /> : <AlertTriangle className="size-4 text-destructive" />}
            <span className="font-medium">
              {backup.state === "ok" ? "Backed up" : backup.state === "stale" ? "Backup overdue" : "No backup recorded yet"}
            </span>
            {backup.lastOkAt && backup.ageHours !== null ? <Badge variant={backup.state === "ok" ? "secondary" : "destructive"}>{formatAge(backup.ageHours)} ago</Badge> : null}
          </div>
          {backup.lastOkAt ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Last good backup {formatDhakaDateTime(backup.lastOkAt)}
              {backupJob?.lastOk ? ` — ${backupDetail(backupJob.lastOk.summary)}` : ""}
            </p>
          ) : null}
          {backup.lastFailure ? (
            <p className="mt-1 text-sm text-destructive">
              The latest attempt failed ({formatDhakaDateTime(backup.lastFailure.at)}){backup.lastFailure.error ? `: ${backup.lastFailure.error}` : ""}
            </p>
          ) : null}
          {backup.state !== "ok" ? (
            <p className="mt-2 text-sm">
              Check the server: the nightly <code className="rounded bg-muted px-1 text-xs">scripts/backup.sh</code> cron entry and its log (docs/BACKUPS.md). Run it once by hand to confirm it works.
            </p>
          ) : null}
        </div>

        <ul className="flex flex-col divide-y rounded-lg border">
          {(["trash-purge", "low-stock-alert"] as const).map((job) => {
            const status = byJob[job];
            const last = status?.last;
            return (
              <li key={job} className="flex items-start gap-3 p-3">
                {!last ? <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : last.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />}
                <div className="min-w-0 text-sm">
                  <p className="font-medium">{JOB_LABELS[job].title}</p>
                  <p className="text-xs text-muted-foreground">{JOB_LABELS[job].schedule}</p>
                  <p className={last && !last.ok ? "mt-1 text-destructive" : "mt-1 text-muted-foreground"}>
                    {!last
                      ? "Hasn't run yet."
                      : last.ok
                        ? `Last ran ${formatDhakaDateTime(last.finishedAt)} — ${job === "trash-purge" ? purgeDetail(last.summary) : alertDetail(last.summary)}`
                        : `Failed ${formatDhakaDateTime(last.finishedAt)}: ${last.error ?? "unknown error"}`}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
