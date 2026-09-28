"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PackageCheck, Search } from "lucide-react";

import { ListPagination } from "@/components/list/list-pagination";
import { usePager } from "@/components/list/list-prefs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PackingQueueCard } from "@/components/packing/packing-queue-card";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { PACKING_VIEW_LABELS, PACKING_VIEWS, type PackingQueueItem, type PackingView } from "@/lib/packing/types";

const EMPTY: Record<PackingView, { title: string; body: string }> = {
  queue: { title: "Queue is empty", body: "No confirmed orders are waiting to be packed." },
  overdue: { title: "Nothing overdue", body: "Every order in the queue is inside the packing SLA." },
  ready: { title: "Nothing waiting for the courier", body: "Packed parcels show here until they're handed over." },
  packed_today: { title: "Nothing packed yet today", body: "Parcels show here as they're marked packed." },
};

/** P4.3 — `view` comes from the URL (the Packing dashboard links to each one). */
export function PackingQueue({ view = "queue" }: { view?: PackingView }) {
  const [items, setItems] = useState<PackingQueueItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const pager = usePager("packing");
  const { page, pageSize, setPage } = pager;
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedQ) params.set("q", debouncedQ);
    params.set("view", view);
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));

    fetchJson<{ items: PackingQueueItem[]; total: number }>(`/api/packing/queue?${params.toString()}`)
      .then((data) => {
        setItems(data.items);
        setTotal(data.total);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the packing queue."));
  }, [debouncedQ, page, pageSize, view]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
        {PACKING_VIEWS.map((v) => (
          <Button key={v} size="sm" variant={v === view ? "default" : "outline"} render={<Link href={v === "queue" ? "/packing" : `/packing?view=${v}`} />} nativeButton={false}>
            {PACKING_VIEW_LABELS[v]}
          </Button>
        ))}
      </div>
      <div className="relative max-w-xs">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Order no, name, or phone..."
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            pager.reset();
          }}
          className="pl-8"
        />
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!items ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-56 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <PackageCheck className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">{EMPTY[view].title}</p>
          <p className="text-sm text-muted-foreground">{EMPTY[view].body}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((order) => (
            <PackingQueueCard key={order.id} order={order} />
          ))}
        </div>
      )}

      {items && items.length > 0 ? (
        <ListPagination page={page} pageSize={pageSize} total={total} noun="orders" onPageChange={setPage} onPageSizeChange={pager.setPageSize} />
      ) : null}
    </div>
  );
}
