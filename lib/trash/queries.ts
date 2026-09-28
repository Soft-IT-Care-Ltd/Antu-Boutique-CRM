import "server-only";

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import type { PermissionKey } from "@/lib/auth/permission-definitions";
import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import type { Db } from "@/lib/db/tx";
import { daysLeftInTrash, purgeDueAt, TRASH_KINDS, type TrashKind } from "@/lib/trash/policy";
import { DEFAULT_PAGE_SIZE, pageArgs } from "@/lib/list/pagination";

// PRD §4.18 — the Trash screen's read side. One kind at a time, each gated
// by that module's delete permission (the same one that restores it) and,
// for orders, customers and leads, scoped by the shared helper (CLAUDE.md
// rule 6) — a delete permission granted to an executive still only shows
// their own. Archived rows (lib/trash/purge.ts) have left the trash.

export const TRASH_PERMISSIONS: Record<TrashKind, PermissionKey> = {
  order: "order.delete",
  customer: "customer.delete",
  product: "product.delete",
  lead: "lead.delete",
};

export const trashQuerySchema = z.object({
  kind: z.enum(TRASH_KINDS).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
export type TrashQuery = z.infer<typeof trashQuerySchema>;

export type TrashItem = {
  id: string;
  kind: TrashKind;
  title: string;
  subtitle: string | null;
  deletedAt: string;
  purgeAt: string;
  daysLeft: number;
  deletedBy: string | null;
};

export type TrashPage = { kind: TrashKind; items: TrashItem[]; total: number; page: number; pageSize: number; counts: Partial<Record<TrashKind, number>> };

// The audit action each kind's delete writes — for "deleted by".
const TRASH_ACTIONS: Record<TrashKind, string> = {
  order: "order.trash",
  customer: "customer.trash",
  product: "catalog.product.trash",
  lead: "lead.delete",
};

const contains = (q: string) => ({ contains: q, mode: "insensitive" as const });

function orderWhere(user: SessionUser, q?: string): Prisma.OrderWhereInput {
  const base: Prisma.OrderWhereInput = { deletedAt: { not: null } };
  if (q) base.OR = [{ orderNo: contains(q) }, { customer: { name: contains(q) } }, { customer: { phone: { contains: q } } }];
  return scopedWhere(base, user) as Prisma.OrderWhereInput;
}
function customerWhere(user: SessionUser, q?: string): Prisma.CustomerWhereInput {
  const base: Prisma.CustomerWhereInput = { deletedAt: { not: null }, archivedAt: null };
  if (q) base.OR = [{ name: contains(q) }, { phone: { contains: q } }];
  return scopedWhere(base, user) as Prisma.CustomerWhereInput;
}
function productWhere(q?: string): Prisma.ProductWhereInput {
  const base: Prisma.ProductWhereInput = { deletedAt: { not: null }, archivedAt: null };
  if (q) base.OR = [{ name: contains(q) }, { code: contains(q) }];
  return base;
}
function leadWhere(user: SessionUser, q?: string): Prisma.LeadWhereInput {
  const base: Prisma.LeadWhereInput = { deletedAt: { not: null } };
  if (q) base.OR = [{ name: contains(q) }, { phone: { contains: q } }];
  return scopedWhere(base, user) as Prisma.LeadWhereInput;
}

async function countKind(db: Db, kind: TrashKind, user: SessionUser, q?: string): Promise<number> {
  switch (kind) {
    case "order":
      return db.order.count({ where: orderWhere(user, q) });
    case "customer":
      return db.customer.count({ where: customerWhere(user, q) });
    case "product":
      return db.product.count({ where: productWhere(q) });
    case "lead":
      return db.lead.count({ where: leadWhere(user, q) });
  }
}

type Row = { id: string; title: string; subtitle: string | null; deletedAt: Date };

async function rowsOf(db: Db, kind: TrashKind, user: SessionUser, q: string | undefined, paging: { skip: number; take: number }): Promise<Row[]> {
  const page = { orderBy: { deletedAt: "desc" as const }, ...paging };
  switch (kind) {
    case "order": {
      const rows = await db.order.findMany({ where: orderWhere(user, q), ...page, select: { id: true, orderNo: true, status: true, deletedAt: true, customer: { select: { name: true, phone: true } } } });
      return rows.map((o) => ({ id: o.id, title: o.orderNo, subtitle: [o.customer?.name, o.customer?.phone, o.status === "LEAD" ? "never confirmed" : "cancelled"].filter(Boolean).join(" · "), deletedAt: o.deletedAt! }));
    }
    case "customer": {
      const rows = await db.customer.findMany({ where: customerWhere(user, q), ...page, select: { id: true, name: true, phone: true, deletedAt: true } });
      return rows.map((c) => ({ id: c.id, title: c.name, subtitle: c.phone, deletedAt: c.deletedAt! }));
    }
    case "product": {
      const rows = await db.product.findMany({ where: productWhere(q), ...page, select: { id: true, name: true, code: true, deletedAt: true, _count: { select: { variants: true } } } });
      return rows.map((p) => ({ id: p.id, title: p.name, subtitle: `${p.code} · ${p._count.variants} variant${p._count.variants === 1 ? "" : "s"}`, deletedAt: p.deletedAt! }));
    }
    case "lead": {
      const rows = await db.lead.findMany({ where: leadWhere(user, q), ...page, select: { id: true, name: true, phone: true, status: true, deletedAt: true } });
      return rows.map((l) => ({ id: l.id, title: l.name, subtitle: [l.phone, l.status.replace(/_/g, " ").toLowerCase()].filter(Boolean).join(" · "), deletedAt: l.deletedAt! }));
    }
  }
}

/** The kinds this person may see in the trash (their delete permissions). */
export function visibleTrashKinds(permissions: ReadonlySet<PermissionKey>): TrashKind[] {
  return TRASH_KINDS.filter((k) => permissions.has(TRASH_PERMISSIONS[k]));
}

export async function listTrash(db: Db, user: SessionUser, kinds: TrashKind[], query: TrashQuery, now = new Date()): Promise<TrashPage | null> {
  const kind = query.kind && kinds.includes(query.kind) ? query.kind : kinds[0];
  if (!kind) return null;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

  const [countEntries, total, rows] = await Promise.all([
    Promise.all(kinds.map(async (k) => [k, await countKind(db, k, user)] as const)),
    countKind(db, kind, user, query.q),
    rowsOf(db, kind, user, query.q, pageArgs({ page: query.page, pageSize })),
  ]);

  // Who deleted each one: the newest trash audit row per record.
  const audits = rows.length
    ? await db.auditLog.findMany({
        where: { action: TRASH_ACTIONS[kind], entityId: { in: rows.map((r) => r.id) } },
        orderBy: { createdAt: "desc" },
        select: { entityId: true, actor: { select: { name: true } } },
      })
    : [];
  const deletedBy = new Map<string, string | null>();
  for (const a of audits) if (!deletedBy.has(a.entityId)) deletedBy.set(a.entityId, a.actor?.name ?? null);

  return {
    kind,
    total,
    page: query.page,
    pageSize,
    counts: Object.fromEntries(countEntries),
    items: rows.map((r) => ({
      id: r.id,
      kind,
      title: r.title,
      subtitle: r.subtitle,
      deletedAt: r.deletedAt.toISOString(),
      purgeAt: purgeDueAt(r.deletedAt).toISOString(),
      daysLeft: daysLeftInTrash(r.deletedAt, now),
      deletedBy: deletedBy.get(r.id) ?? null,
    })),
  };
}
