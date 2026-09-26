-- P5.1 — rules the database holds for the trash archive and job runs.

-- Only something already in the trash can be archived by the purge, and an
-- archived row can't come back out of the trash on its own: restoring it
-- (a new order on the same phone) clears both together.
ALTER TABLE "customers" ADD CONSTRAINT "customers_archived_chk" CHECK ("archivedAt" IS NULL OR "deletedAt" IS NOT NULL);
ALTER TABLE "products" ADD CONSTRAINT "products_archived_chk" CHECK ("archivedAt" IS NULL OR "deletedAt" IS NOT NULL);

-- A run names a known job, ends after it starts, and a failed one says why.
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_job_chk" CHECK ("job" IN ('backup', 'trash-purge', 'low-stock-alert'));
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_times_chk" CHECK ("finishedAt" >= "startedAt");
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_error_chk" CHECK ("ok" OR NULLIF(btrim("error"), '') IS NOT NULL);
