"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Search, UserX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, fetchJson } from "@/lib/customers/client";
import { CUSTOMER_TAG_LABELS, CUSTOMER_TAG_VALUES, type CustomerTagValue } from "@/lib/customers/constants";
import type { CustomerListItem } from "@/lib/customers/types";

const PAGE_SIZE = 20;

const TAG_VARIANT: Record<CustomerTagValue, "default" | "secondary" | "destructive"> = {
  VIP: "default",
  WHOLESALE: "secondary",
  PROBLEM_CUSTOMER: "destructive",
};

export function CustomerList({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [items, setItems] = useState<CustomerListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [tag, setTag] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedQ) params.set("q", debouncedQ);
    if (tag !== "all") params.set("tag", tag);
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));

    fetchJson<{ items: CustomerListItem[]; total: number }>(`/api/customers?${params.toString()}`)
      .then((data) => {
        setItems(data.items);
        setTotal(data.total);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load customers."));
  }, [debouncedQ, tag, page]);

  function updateFilter<T>(setter: (value: T) => void, value: T) {
    setter(value);
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search phone or name..."
              value={q}
              onChange={(e) => updateFilter(setQ, e.target.value)}
              className="pl-8"
            />
          </div>
          <Select value={tag} onValueChange={(v) => updateFilter(setTag, v as string)}>
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue placeholder="Tag" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tags</SelectItem>
              {CUSTOMER_TAG_VALUES.map((t) => (
                <SelectItem key={t} value={t}>
                  {CUSTOMER_TAG_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {canCreate ? (
          <Button render={<Link href="/customers/new" />} nativeButton={false}>
            <Plus />
            New customer
          </Button>
        ) : null}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!items ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <UserX className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No customers found</p>
          <p className="text-sm text-muted-foreground">Try a different search, or add a new customer.</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead>Added</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((customer) => (
              <TableRow
                key={customer.id}
                className="cursor-pointer"
                onClick={() => router.push(`/customers/${customer.id}`)}
              >
                <TableCell className="font-medium">{customer.name}</TableCell>
                <TableCell className="font-mono text-sm">{customer.phone}</TableCell>
                <TableCell className="text-muted-foreground">
                  {[customer.thana, customer.district, customer.division].filter(Boolean).join(", ") || "—"}
                </TableCell>
                <TableCell>
                  {customer.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {customer.tags.map((t) => (
                        <Badge key={t} variant={TAG_VARIANT[t]}>
                          {CUSTOMER_TAG_LABELS[t]}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(customer.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {items && items.length > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {page} of {totalPages} · {total} customers
          </span>
          <div className="flex gap-1">
            <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="icon-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
