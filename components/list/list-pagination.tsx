"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PAGE_SIZE_OPTIONS, pageInfo } from "@/lib/list/pagination";
import { cn } from "@/lib/utils";

// CORRECTIONS.md item 15 — the one pagination bar under every list:
// "Showing X–Y of Z", 25 / 50 / 100 per page, previous / next. `children`
// sits after the count (a list's own totals, e.g. "৳ 1,42,000 due").

export type ListPaginationProps = {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  /** "orders", "customers" — what the rows are. */
  noun?: string;
  children?: React.ReactNode;
  className?: string;
};

export function ListPagination({ page, pageSize, total, onPageChange, onPageSizeChange, noun, children, className }: ListPaginationProps) {
  const { totalPages, first, last } = pageInfo(total, page, pageSize);
  return (
    <div className={cn("flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between", className)}>
      <span>
        Showing {first.toLocaleString("en-IN")}–{last.toLocaleString("en-IN")} of {total.toLocaleString("en-IN")}
        {noun ? ` ${noun}` : ""}
        {children}
      </span>
      <div className="flex items-center gap-2">
        <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
          <SelectTrigger size="sm" aria-label="Rows per page" className="w-[7.5rem]">
            <SelectValue>{(v: string) => `${v} per page`}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} per page
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="whitespace-nowrap tabular-nums">
          {page} / {totalPages}
        </span>
        <div className="flex gap-1">
          <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
