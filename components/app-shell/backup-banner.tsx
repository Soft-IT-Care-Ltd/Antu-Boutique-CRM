import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { formatAge, type BackupHealth } from "@/lib/system/job-status";

// PRD §4.18 — "alert if the last backup is older than 48 hours". Shown to
// whoever runs Settings, on every page, until a fresh backup is reported.
// Worked out when the page renders (lib/system/jobs.ts getBackupHealth), so
// it still appears if the cron that should have run the backup is broken.
export function BackupBanner({ health }: { health: BackupHealth }) {
  return (
    <div role="alert" className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1">
        {health.state === "never" ? "No database backup has been recorded yet." : `The last database backup was ${formatAge(health.ageHours ?? 0)} ago.`}{" "}
        <Link href="/settings#system" className="font-medium underline underline-offset-4">
          Check backups
        </Link>
      </p>
    </div>
  );
}
