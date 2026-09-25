import "server-only";

import type { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import { withTx, type Db } from "@/lib/db/tx";
import { dhakaDayStartUtc, todayInDhaka } from "@/lib/inventory/constants";
import { LEAD_SOURCE_LABELS, LEAD_SOURCE_VALUES, MAX_DAILY_COUNT_ROWS } from "@/lib/leads/constants";
import { canActForLeadPerson } from "@/lib/leads/queries";
import { LeadError } from "@/lib/leads/service";
import type { DailyCountDay, DailyCountRow, DailyCountSheet } from "@/lib/leads/types";

// PRD §4.5 bulk daily-count quick entry. One person's day is one sheet:
// saving it replaces that day's rows for that person, so correcting a count
// is just saving the sheet again. Every save is audit-logged with the rows
// before and after.

function dayOf(date: Date): string {
  // countDate is Dhaka midnight as UTC; +6h lands on the Dhaka calendar day.
  return new Date(date.getTime() + 6 * 3_600_000).toISOString().slice(0, 10);
}

const toRow = (r: { source: DailyCountRow["source"]; campaign: string | null; leadCount: number; convertedCount: number }): DailyCountRow => ({
  source: r.source,
  campaign: r.campaign,
  leadCount: r.leadCount,
  convertedCount: r.convertedCount,
});

const rowOrder = (a: DailyCountRow, b: DailyCountRow) =>
  LEAD_SOURCE_VALUES.indexOf(a.source) - LEAD_SOURCE_VALUES.indexOf(b.source) || (a.campaign ?? "").localeCompare(b.campaign ?? "");

/**
 * Rows with the same source and campaign (ignoring case and spacing) are
 * added together; empty rows are dropped.
 */
export function mergeDailyRows(rows: DailyCountRow[]): DailyCountRow[] {
  const merged = new Map<string, DailyCountRow>();
  for (const row of rows) {
    if (row.leadCount <= 0) continue;
    const campaign = row.campaign?.trim().replace(/\s+/g, " ") || null;
    const key = `${row.source}|${campaign?.toLowerCase() ?? ""}`;
    const prev = merged.get(key);
    merged.set(key, prev ? { ...prev, leadCount: prev.leadCount + row.leadCount, convertedCount: prev.convertedCount + row.convertedCount } : { ...row, campaign });
  }
  return [...merged.values()].sort(rowOrder);
}

export async function getDailySheet(db: Db, user: SessionUser, userId: string, day: string): Promise<DailyCountSheet> {
  if (!(await canActForLeadPerson(db, user, userId))) throw new LeadError("You can't see that person's lead counts.", 403);
  const rows = await db.leadDailyCount.findMany({
    where: { userId, countDate: dhakaDayStartUtc(day) },
    include: { createdBy: { select: { id: true, name: true } } },
    orderBy: { updatedAt: "desc" },
  });
  return {
    userId,
    day,
    rows: rows.map(toRow).sort(rowOrder),
    updatedAt: rows[0]?.updatedAt.toISOString() ?? null,
    enteredBy: rows[0]?.createdBy ?? null,
  };
}

export async function saveDailySheet(db: Db, user: SessionUser, input: { userId: string; day: string; rows: DailyCountRow[] }, ctx: { request?: Request } = {}): Promise<DailyCountSheet> {
  const target = await canActForLeadPerson(db, user, input.userId);
  if (!target) throw new LeadError("You can't record lead counts for that person.", 403);
  if (input.day > todayInDhaka()) throw new LeadError("That day hasn't happened yet — count leads on or after the day.");

  const rows = mergeDailyRows(input.rows);
  if (rows.length > MAX_DAILY_COUNT_ROWS) throw new LeadError(`At most ${MAX_DAILY_COUNT_ROWS} rows a day.`);
  for (const row of rows) {
    if (row.convertedCount > row.leadCount) {
      throw new LeadError(`${LEAD_SOURCE_LABELS[row.source]}${row.campaign ? ` · ${row.campaign}` : ""}: more converted (${row.convertedCount}) than leads (${row.leadCount}).`);
    }
  }

  const countDate = dhakaDayStartUtc(input.day);
  await withTx(db, async (tx) => {
    // One save at a time per person and day, so two saves can't both
    // clear the day and then both write their rows.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`lead_daily_counts:${target.id}:${input.day}`}))::text`;
    const before = await tx.leadDailyCount.findMany({ where: { userId: target.id, countDate } });
    await tx.leadDailyCount.deleteMany({ where: { userId: target.id, countDate } });
    if (rows.length > 0) {
      await tx.leadDailyCount.createMany({
        data: rows.map((r) => ({ countDate, userId: target.id, teamId: target.teamId, source: r.source, campaign: r.campaign, leadCount: r.leadCount, convertedCount: r.convertedCount, createdById: user.id })),
      });
    }
    if (before.length > 0 || rows.length > 0) {
      await writeAuditLogWith(tx, {
        actorId: user.id,
        action: "lead.daily_counts.save",
        entityType: "lead_daily_counts",
        entityId: `${target.id}:${input.day}`,
        before: { userId: target.id, day: input.day, rows: before.map(toRow) },
        after: { userId: target.id, day: input.day, rows },
        request: ctx.request,
      });
    }
  });

  return getDailySheet(db, user, target.id, input.day);
}

/** Saved days in a range, newest first, within this user's scope. */
export async function listDailyCountDays(db: Db, user: SessionUser, opts: { fromDay: string; toDay: string; userId?: string }): Promise<DailyCountDay[]> {
  const where = scopedWhere(
    {
      countDate: { gte: dhakaDayStartUtc(opts.fromDay), lt: dhakaDayStartUtc(opts.toDay, 1) },
      ...(opts.userId ? { userId: opts.userId } : {}),
    },
    user,
    { ownerField: "userId" },
  ) as Prisma.LeadDailyCountWhereInput;

  const rows = await db.leadDailyCount.findMany({
    where,
    include: { user: { select: { id: true, name: true } } },
    orderBy: [{ countDate: "desc" }, { userId: "asc" }],
    take: 2000,
  });

  const days = new Map<string, DailyCountDay>();
  for (const r of rows) {
    const day = dayOf(r.countDate);
    const key = `${day}|${r.userId}`;
    const entry = days.get(key) ?? { userId: r.userId, userName: r.user.name, day, leadCount: 0, convertedCount: 0, rows: [] };
    entry.leadCount += r.leadCount;
    entry.convertedCount += r.convertedCount;
    entry.rows.push(toRow(r));
    days.set(key, entry);
  }
  return [...days.values()].map((d) => ({ ...d, rows: d.rows.sort(rowOrder) }));
}
