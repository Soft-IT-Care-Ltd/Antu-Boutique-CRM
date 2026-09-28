import { z } from "zod";

// CORRECTIONS.md item 15 — one pagination for every list: 25 / 50 / 100
// per page, server-side, "showing X–Y of Z", and the choice remembered per
// user per list (lib/list/prefs.ts). Client- and server-safe.

export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

/** Every list whose page size is remembered. The key is what's stored per user. */
export const LIST_KEYS = [
  "orders",
  "edit_requests",
  "customers",
  "products",
  "leads",
  "payments",
  "expenses",
  "ad_spend",
  "purchases",
  "stock",
  "movements",
  "transfers",
  "stock_counts",
  "shipments",
  "courier_returns",
  "cod",
  "returns",
  "packing",
  "drawer_history",
  "users",
  "audit_log",
  "trash",
  "report",
] as const;
export type ListKey = (typeof LIST_KEYS)[number];

export const isPageSize = (n: number) => (PAGE_SIZE_OPTIONS as readonly number[]).includes(n);

/** What a list API reads from its query string. Any 1–100 size is served; the UI offers 25 / 50 / 100. */
export const paginationQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(DEFAULT_PAGE_SIZE),
};

/** Prisma's skip/take for a page. */
export const pageArgs = ({ page, pageSize }: { page: number; pageSize: number }) => ({ skip: (page - 1) * pageSize, take: pageSize });

export function pageInfo(total: number, page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return { totalPages, first, last };
}

/** A lenient page/pageSize read for server-rendered pages: anything odd falls back. */
export function readPageParams(params: Record<string, string | string[] | undefined>, savedPageSize: number) {
  const one = (k: string) => {
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const page = Math.max(1, Number.parseInt(one("page") ?? "1", 10) || 1);
  const asked = Number.parseInt(one("pageSize") ?? "", 10);
  return { page, pageSize: isPageSize(asked) ? asked : savedPageSize };
}
