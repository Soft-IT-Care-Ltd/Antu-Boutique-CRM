"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, History } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDhakaDate } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { DrawerHistoryItem } from "@/lib/pos/types";

const PAGE_SIZE = 15;
const dayLabel = (ymd: string) => formatDhakaDate(`${ymd}T00:00:00+06:00`);

/** Every day's count, newest first — each row opens that day's reconciliation. */
export function DrawerHistory() {
  const [data, setData] = useState<{ items: DrawerHistoryItem[]; total: number } | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<{ items: DrawerHistoryItem[]; total: number }>(`/api/pos/drawer/history?page=${page}&pageSize=${PAGE_SIZE}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load past days."));
  }, [page]);

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <History className="size-4" /> Past days
      </h2>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {!data ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : data.items.length === 0 ? (
        <p className="rounded-xl border border-dashed py-8 text-center text-sm text-muted-foreground">No drawer has been opened yet.</p>
      ) : (
        <div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead className="text-right">Opening</TableHead>
                <TableHead className="text-right">Should hold</TableHead>
                <TableHead className="text-right">Counted</TableHead>
                <TableHead className="text-right">Over / short</TableHead>
                <TableHead>Closed by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((d) => {
                const diff = d.difference === null ? null : Number(d.difference);
                return (
                  <TableRow key={d.id}>
                    <TableCell>
                      <Link href={`/pos/drawer/${d.id}`} className="font-medium hover:underline">
                        {dayLabel(d.businessDay)}
                      </Link>
                      {d.status === "OPEN" ? <Badge className="ml-1.5">Open</Badge> : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatBDT(d.openingCount)}</TableCell>
                    <TableCell className="text-right tabular-nums">{d.expectedClose ? formatBDT(d.expectedClose) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{d.closingCount ? formatBDT(d.closingCount) : "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums ${diff ? "text-destructive" : "text-muted-foreground"}`}>
                      {diff === null ? "—" : diff === 0 ? "Matched" : `${diff < 0 ? "Short" : "Over"} ${formatBDT(Math.abs(diff))}`}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{d.closedByName ?? "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {data && data.total > PAGE_SIZE ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-1">
            <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight />
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
