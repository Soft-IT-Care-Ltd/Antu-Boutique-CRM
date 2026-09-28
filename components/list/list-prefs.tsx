"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { DEFAULT_PAGE_SIZE, type ListKey } from "@/lib/list/pagination";

// CORRECTIONS.md item 15 — each person's page size per list, loaded once by
// the dashboard layout and saved in the background when they change it, so
// the next visit (on any device) opens at the size they picked.

type Ctx = { sizes: Partial<Record<ListKey, number>>; set: (key: ListKey, size: number) => void };

const ListPrefsContext = createContext<Ctx | null>(null);

export function ListPrefsProvider({ initial, children }: { initial: Partial<Record<ListKey, number>>; children: React.ReactNode }) {
  const [sizes, setSizes] = useState(initial);
  const set = useCallback((key: ListKey, size: number) => {
    setSizes((prev) => ({ ...prev, [key]: size }));
    // keepalive: the save still lands if they open a row and leave the page straight away.
    fetch("/api/me/list-preferences", { method: "PUT", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ listKey: key, pageSize: size }) }).catch(() => {});
  }, []);
  const value = useMemo(() => ({ sizes, set }), [sizes, set]);
  return <ListPrefsContext.Provider value={value}>{children}</ListPrefsContext.Provider>;
}

/** The remembered page size for a list, and a setter that remembers the new one. */
export function useListPageSize(key: ListKey): [number, (size: number) => void] {
  const ctx = useContext(ListPrefsContext);
  const size = ctx?.sizes[key] ?? DEFAULT_PAGE_SIZE;
  const set = useCallback((n: number) => ctx?.set(key, n), [ctx, key]);
  return [size, set];
}

/**
 * Page + page size for a client-fetched list. `reset()` goes back to page 1
 * (call it whenever a filter changes); changing the size also resets.
 */
export function usePager(key: ListKey) {
  const [pageSize, savePageSize] = useListPageSize(key);
  const [page, setPage] = useState(1);
  const setPageSize = useCallback(
    (n: number) => {
      savePageSize(n);
      setPage(1);
    },
    [savePageSize],
  );
  const reset = useCallback(() => setPage(1), []);
  return { page, pageSize, setPage, setPageSize, reset };
}

export type Pager = ReturnType<typeof usePager>;
