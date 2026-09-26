// Pure job/backup-status rules (no DB), shared by the server helpers in
// lib/system/jobs.ts, the Settings card and the app-shell banner.

export const JOB_NAMES = ["backup", "trash-purge", "low-stock-alert"] as const;
export type JobName = (typeof JOB_NAMES)[number];

export const JOB_LABELS: Record<JobName, { title: string; schedule: string }> = {
  backup: { title: "Database backup", schedule: "Nightly pg_dump, kept 14 days" },
  "trash-purge": { title: "Trash purge", schedule: "Nightly — removes what has been in the trash 30 days" },
  "low-stock-alert": { title: "Low-stock alert", schedule: "Daily, to everyone who buys stock" },
};

/** PRD §4.18: alert if the last backup is older than this. */
export const BACKUP_STALE_HOURS = 48;
export const BACKUP_RETENTION_DAYS = 14;

export type BackupHealth = {
  state: "ok" | "stale" | "never";
  lastOkAt: string | null;
  ageHours: number | null;
  /** The newest run failed (even if an older one is still fresh). */
  lastFailure: { at: string; error: string | null } | null;
};

export function backupHealth(lastOkAt: Date | null, now: Date, lastFailure: { at: Date; error: string | null } | null = null): BackupHealth {
  const failure = lastFailure ? { at: lastFailure.at.toISOString(), error: lastFailure.error } : null;
  if (!lastOkAt) return { state: "never", lastOkAt: null, ageHours: null, lastFailure: failure };
  const ageHours = Math.max(0, (now.getTime() - lastOkAt.getTime()) / 3_600_000);
  return { state: ageHours > BACKUP_STALE_HOURS ? "stale" : "ok", lastOkAt: lastOkAt.toISOString(), ageHours, lastFailure: failure };
}

/** "3 hours", "2 days" — how long ago, for people. */
export function formatAge(hours: number): string {
  if (hours < 1) return "under an hour";
  if (hours < 48) {
    const h = Math.floor(hours);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.floor(hours / 24);
  return `${d} days`;
}
