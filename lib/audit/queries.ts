import "server-only";

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { stripCostFields } from "@/lib/auth/strip-cost-fields";
import type { Db } from "@/lib/db/tx";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";

// P4.4 (PRD §3.1, §4.15) — the audit-log viewer's read side: every
// sensitive change, newest first, filterable by who did it, what kind of
// record it touched (and which one), what they did, and when. ADMIN only
// (audit.view) — the routes and the page check it; this never does.
// audit.view can be granted per user, so before/after (a price change, a
// purchase, a stock adjustment) lose their cost fields for anyone without
// product.cost.view, like every other response (CLAUDE.md rule 5).

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD");
const text = z.string().trim().min(1).max(100);

export const auditFilterSchema = z
  .object({
    actor: text.optional(),
    entity: z.string().trim().regex(/^[a-z_]{1,50}$/, "Unknown record type").optional(),
    entityId: text.optional(),
    action: text.optional(),
    from: day.optional(),
    to: day.optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, "The start date must be on or before the end date");

export type AuditFilters = z.infer<typeof auditFilterSchema>;

export const AUDIT_PAGE_SIZE = 50;

export type AuditLogView = {
  id: string;
  createdAt: string;
  actor: { id: string; name: string } | null;
  action: string;
  entityType: string;
  entityId: string;
  entityHref: string | null;
  ipAddress: string | null;
  /** Top-level fields whose value differs between before and after. */
  changed: string[];
  before: unknown;
  after: unknown;
};

const ENTITY_LINKS: Record<string, (id: string) => string> = {
  order: (id) => `/orders/${id}`,
  customer: (id) => `/customers/${id}`,
  product: (id) => `/catalog/products/${id}`,
  lead: (id) => `/leads/${id}`,
};

function changedKeys(before: unknown, after: unknown): string[] {
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const b = obj(before);
  const a = obj(after);
  if (!b && !a) return [];
  if (!b || !a) return Object.keys(b ?? a ?? {});
  return [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
}

export function auditWhere(f: AuditFilters): Prisma.AuditLogWhereInput {
  return {
    ...(f.actor ? { actorId: f.actor } : {}),
    ...(f.entity ? { entityType: f.entity } : {}),
    ...(f.entityId ? { entityId: f.entityId } : {}),
    ...(f.action ? { action: { contains: f.action, mode: "insensitive" as const } } : {}),
    ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: dhakaDayStartUtc(f.from) } : {}), ...(f.to ? { lt: dhakaDayStartUtc(f.to, 1) } : {}) } } : {}),
  };
}

export async function listAuditLogs(db: Db, f: AuditFilters, canSeeCost: boolean): Promise<{ items: AuditLogView[]; total: number; page: number; pageSize: number }> {
  const where = auditWhere(f);
  const [total, rows] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (f.page - 1) * AUDIT_PAGE_SIZE,
      take: AUDIT_PAGE_SIZE,
      include: { actor: { select: { id: true, name: true } } },
    }),
  ]);
  return {
    total,
    page: f.page,
    pageSize: AUDIT_PAGE_SIZE,
    items: rows.map((r) => {
      const before = stripCostFields(r.before, canSeeCost);
      const after = stripCostFields(r.after, canSeeCost);
      return {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        actor: r.actor,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        entityHref: ENTITY_LINKS[r.entityType]?.(r.entityId) ?? null,
        ipAddress: r.ipAddress,
        changed: changedKeys(before, after),
        before,
        after,
      };
    }),
  };
}

/** The filter dropdowns: everyone who has ever been logged, and every record type seen. */
export async function auditFilterOptions(db: Db): Promise<{ actors: { id: string; name: string }[]; entities: string[] }> {
  const [actors, entities] = await Promise.all([
    db.user.findMany({ where: { auditLogs: { some: {} } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.auditLog.groupBy({ by: ["entityType"], orderBy: { entityType: "asc" } }),
  ]);
  return { actors, entities: entities.map((e) => e.entityType) };
}
