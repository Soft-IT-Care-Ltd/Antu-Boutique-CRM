-- P4.1 — rules the database holds for leads (PRD §4.5).

ALTER TABLE "leads" ADD CONSTRAINT "leads_name_chk" CHECK (NULLIF(btrim("name"), '') IS NOT NULL);

-- A lost lead always says why, and when; nothing else carries a reason.
ALTER TABLE "leads" ADD CONSTRAINT "leads_lost_chk"
  CHECK (("status" = 'LOST') = ("lostReason" IS NOT NULL) AND ("status" = 'LOST') = ("lostAt" IS NOT NULL));
-- "Other" needs the reason written down.
ALTER TABLE "leads" ADD CONSTRAINT "leads_lost_note_chk"
  CHECK ("lostReason" IS DISTINCT FROM 'OTHER' OR NULLIF(btrim("lostNote"), '') IS NOT NULL);

ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_chk" CHECK (("status" = 'CONVERTED') = ("convertedAt" IS NOT NULL));

ALTER TABLE "lead_daily_counts" ADD CONSTRAINT "lead_daily_counts_counts_chk"
  CHECK ("leadCount" BETWEEN 1 AND 10000 AND "convertedCount" >= 0 AND "convertedCount" <= "leadCount");
