"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ClipboardList, Loader2 } from "lucide-react";

import { ListPagination } from "@/components/list/list-pagination";
import { usePager } from "@/components/list/list-prefs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { ORDER_EDIT_REQUEST_STATUS_LABELS, ORDER_EDIT_REQUEST_STATUS_VALUES } from "@/lib/orders/constants";
import type { OrderEditRequestStatusValue } from "@/lib/orders/constants";

type InboxRow = {
  id: string;
  status: OrderEditRequestStatusValue;
  order: { id: string; orderNo: string; status: string; customer: { name: string; phone: string } };
  proposedChanges: unknown;
  requestedBy: { id: string; name: string } | null;
  reviewedBy: { id: string; name: string } | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function EditRequestsList() {
  const [status, setStatus] = useState<OrderEditRequestStatusValue>("PENDING");
  const [items, setItems] = useState<InboxRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const pager = usePager("edit_requests");
  const { page, pageSize, setPage } = pager;
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const reload = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    fetchJson<{ items: InboxRow[]; total: number }>(`/api/order-edit-requests?status=${status}&page=${page}&pageSize=${pageSize}`)
      .then((data) => {
        setItems(data.items);
        setTotal(data.total);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load edit requests."));
  }, [status, page, pageSize, reloadKey]);

  async function review(id: string, action: "approve" | "reject") {
    setBusyId(id);
    setError(null);
    try {
      await fetchJson(`/api/order-edit-requests/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ action, reviewNote: notes[id]?.trim() || undefined }),
      });
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not review this request.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Select
        value={status}
        onValueChange={(v) => {
          setStatus(v as OrderEditRequestStatusValue);
          pager.reset();
        }}
      >
        <SelectTrigger className="w-52">
          <SelectValue placeholder="Status">{(value: string) => ORDER_EDIT_REQUEST_STATUS_LABELS[value as OrderEditRequestStatusValue]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {ORDER_EDIT_REQUEST_STATUS_VALUES.map((s) => (
            <SelectItem key={s} value={s}>
              {ORDER_EDIT_REQUEST_STATUS_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!items ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <ClipboardList className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No {ORDER_EDIT_REQUEST_STATUS_LABELS[status].toLowerCase()} requests</p>
        </div>
      ) : (
        items.map((row) => (
          <Card key={row.id}>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>
                  <Link href={`/orders/${row.order.id}`} className="font-mono hover:underline">
                    {row.order.orderNo}
                  </Link>
                  <span className="ml-2 font-normal text-sm text-muted-foreground">
                    {row.order.customer.name} · {row.order.customer.phone}
                  </span>
                </CardTitle>
                <Badge variant="outline">{ORDER_EDIT_REQUEST_STATUS_LABELS[row.status]}</Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <p className="text-muted-foreground">
                Requested by {row.requestedBy?.name ?? "—"} on {formatDateTime(row.createdAt)}
              </p>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none">Proposed change</summary>
                <pre className="mt-2 overflow-x-auto rounded bg-muted p-2">{JSON.stringify(row.proposedChanges, null, 2)}</pre>
              </details>

              {row.status === "PENDING" ? (
                <div className="flex flex-col gap-2 border-t pt-3">
                  <Textarea
                    placeholder="Review note (optional)"
                    value={notes[row.id] ?? ""}
                    onChange={(e) => setNotes((n) => ({ ...n, [row.id]: e.target.value }))}
                    rows={2}
                  />
                  <div className="flex gap-2">
                    <Button onClick={() => review(row.id, "approve")} disabled={busyId !== null}>
                      {busyId === row.id ? <Loader2 className="animate-spin" /> : null}
                      Approve &amp; apply
                    </Button>
                    <Button variant="outline" onClick={() => review(row.id, "reject")} disabled={busyId !== null}>
                      Reject
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="border-t pt-3 text-muted-foreground">
                  {row.status === "APPROVED" ? "Approved" : "Rejected"} by {row.reviewedBy?.name ?? "—"}
                  {row.reviewedAt ? ` on ${formatDateTime(row.reviewedAt)}` : ""}
                  {row.reviewNote ? ` — "${row.reviewNote}"` : ""}
                </p>
              )}
            </CardContent>
          </Card>
        ))
      )}
      {items && items.length > 0 ? <ListPagination page={page} pageSize={pageSize} total={total} noun="requests" onPageChange={setPage} onPageSizeChange={pager.setPageSize} /> : null}
    </div>
  );
}
