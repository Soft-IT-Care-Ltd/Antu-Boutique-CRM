import "server-only";

import type { Db } from "@/lib/db/tx";
import { DEFAULT_PAGE_SIZE, isPageSize, LIST_KEYS, type ListKey } from "@/lib/list/pagination";

// CORRECTIONS.md item 15 — "the choice remembered per user per list". Read
// once per page load by the dashboard layout (ListPrefsProvider) and by
// server-rendered lists; written by PUT /api/me/list-preferences.

export type ListPageSizes = Partial<Record<ListKey, number>>;

export async function getListPageSizes(db: Db, userId: string): Promise<ListPageSizes> {
  const rows = await db.userListPreference.findMany({ where: { userId }, select: { listKey: true, pageSize: true } });
  const out: ListPageSizes = {};
  for (const r of rows) if ((LIST_KEYS as readonly string[]).includes(r.listKey) && isPageSize(r.pageSize)) out[r.listKey as ListKey] = r.pageSize;
  return out;
}

export async function getListPageSize(db: Db, userId: string, listKey: ListKey): Promise<number> {
  const row = await db.userListPreference.findUnique({ where: { userId_listKey: { userId, listKey } }, select: { pageSize: true } });
  return row && isPageSize(row.pageSize) ? row.pageSize : DEFAULT_PAGE_SIZE;
}

export async function saveListPageSize(db: Db, userId: string, listKey: ListKey, pageSize: number): Promise<void> {
  await db.userListPreference.upsert({
    where: { userId_listKey: { userId, listKey } },
    create: { userId, listKey, pageSize },
    update: { pageSize },
  });
}
