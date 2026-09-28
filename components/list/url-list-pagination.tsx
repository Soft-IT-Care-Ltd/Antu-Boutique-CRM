"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { ListPagination } from "@/components/list/list-pagination";
import { useListPageSize } from "@/components/list/list-prefs";
import type { ListKey } from "@/lib/list/pagination";

/**
 * ListPagination for a server-rendered list: page and pageSize live in the
 * URL (`?page=2&pageSize=50`), and a new size is also remembered for next
 * time. The page reads the size with readPageParams(params, saved).
 */
export function UrlListPagination({
  listKey,
  page,
  pageSize,
  total,
  noun,
  pageParam = "page",
  children,
}: {
  listKey: ListKey;
  page: number;
  pageSize: number;
  total: number;
  noun?: string;
  /** The URL key for the page number — a screen with several paged tables gives each its own. */
  pageParam?: string;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, saveSize] = useListPageSize(listKey);

  const go = (next: { page: number; pageSize?: number }) => {
    const q = new URLSearchParams(params.toString());
    if (next.page > 1) q.set(pageParam, String(next.page));
    else q.delete(pageParam);
    if (next.pageSize) {
      q.set("pageSize", String(next.pageSize));
      // A new size starts every table on this screen from its first page.
      for (const k of [...q.keys()]) if (k === "page" || k.startsWith("page_")) q.delete(k);
    }
    const s = q.toString();
    router.push(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

  return (
    <ListPagination
      page={page}
      pageSize={pageSize}
      total={total}
      noun={noun}
      onPageChange={(p) => go({ page: p })}
      onPageSizeChange={(n) => {
        saveSize(n);
        go({ page: 1, pageSize: n });
      }}
    >
      {children}
    </ListPagination>
  );
}
