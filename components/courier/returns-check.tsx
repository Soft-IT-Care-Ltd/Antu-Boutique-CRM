"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ClipboardCheck, Loader2, Undo2 } from "lucide-react";

import { ListPagination } from "@/components/list/list-pagination";
import { usePager } from "@/components/list/list-prefs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { RETURN_INSPECTION_SOURCE_LABELS, RETURN_INSPECTION_STATUS_LABELS } from "@/lib/courier/constants";
import type { CourierReturnRow } from "@/lib/courier/types";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import { ApiError, fetchJson } from "@/lib/orders/client";

type Mode = { kind: "kept" | "check"; row: CourierReturnRow };

// PRD §4.9 return flow on the Courier page:
//  - Partial delivery → "Mark kept items" (what the customer kept)
//  - Every return     → Packing's condition check, per unit Good / Damaged
// No money here: Packing works this screen.
export function ReturnsCheck({ canCheck, canMarkKept }: { canCheck: boolean; canMarkKept: boolean }) {
  const [status, setStatus] = useState<"open" | "completed">("open");
  const [rows, setRows] = useState<CourierReturnRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const pager = usePager("courier_returns");
  const { page, pageSize, setPage } = pager;
  const [mode, setMode] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    fetchJson<{ items: CourierReturnRow[]; total: number }>(`/api/courier/returns?status=${status}&page=${page}&pageSize=${pageSize}`)
      .then((data) => {
        setRows(data.items);
        setTotal(data.total);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load returns."));
  }, [status, page, pageSize, reloadKey]);

  function showStatus(next: "open" | "completed") {
    if (next === status) return;
    setRows(null);
    setStatus(next);
    pager.reset();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1.5">
        <Button size="sm" variant={status === "open" ? "default" : "outline"} onClick={() => showStatus("open")}>
          Waiting
        </Button>
        <Button size="sm" variant={status === "completed" ? "default" : "outline"} onClick={() => showStatus("completed")}>
          Checked
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!rows ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-14 text-center">
          <Undo2 className="size-8 text-muted-foreground" />
          <p className="max-w-sm text-sm text-muted-foreground">
            {status === "open"
              ? "Nothing coming back. Returned and partially delivered parcels appear here for a condition check."
              : "No returns checked yet."}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rows.map((row) => (
            <div key={row.id} className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link href={`/orders/${row.orderId}`} className="font-mono font-medium hover:underline">
                  {row.orderNo}
                </Link>
                <div className="flex gap-1">
                  <Badge variant="outline">{RETURN_INSPECTION_SOURCE_LABELS[row.source]}</Badge>
                  <Badge variant={row.status === "COMPLETED" ? "secondary" : "default"}>{RETURN_INSPECTION_STATUS_LABELS[row.status]}</Badge>
                </div>
              </div>
              <div className="text-muted-foreground">
                {row.customerName} · <span className="font-mono">{row.phone}</span>
                {row.consignmentId ? (
                  <>
                    {" "}
                    · CN <span className="font-mono">{row.consignmentId}</span>
                  </>
                ) : null}
              </div>
              <ul className="flex flex-col gap-1">
                {row.items.map((item) => (
                  <li key={item.orderItemId} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5">
                      <span className="size-3 shrink-0 rounded-full border" style={{ backgroundColor: item.colorHex }} />
                      {item.productName}{" "}
                      <span className="font-semibold">
                        {item.sizeName} / {item.colorName}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {row.status === "AWAITING_KEPT_ITEMS"
                        ? `${item.orderedQty} sent`
                        : row.status === "COMPLETED"
                          ? item.expectedBackQty > 0
                            ? `${item.goodQty} good · ${item.damagedQty} damaged`
                            : "kept"
                          : item.expectedBackQty > 0
                            ? `${item.expectedBackQty} coming back`
                            : "kept by customer"}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between gap-2 border-t pt-2">
                <span className="text-xs text-muted-foreground">
                  {row.status === "COMPLETED" && row.inspectedAt ? `Checked ${formatDhakaDateTime(row.inspectedAt)} by ${row.inspectedBy ?? "—"}` : `Since ${formatDhakaDateTime(row.createdAt)}`}
                </span>
                {row.status === "AWAITING_KEPT_ITEMS" && canMarkKept ? (
                  <Button size="sm" onClick={() => setMode({ kind: "kept", row })}>
                    Mark kept items
                  </Button>
                ) : null}
                {row.status === "PENDING" && canCheck ? (
                  <Button size="sm" onClick={() => setMode({ kind: "check", row })}>
                    <ClipboardCheck />
                    Condition check
                  </Button>
                ) : null}
              </div>
              {row.note ? <p className="text-xs text-muted-foreground">Note: {row.note}</p> : null}
            </div>
          ))}
        </div>
      )}

      {rows && rows.length > 0 ? <ListPagination page={page} pageSize={pageSize} total={total} noun="parcels" onPageChange={setPage} onPageSizeChange={pager.setPageSize} /> : null}

      {mode ? (
        <ReturnActionDialog
          key={`${mode.kind}:${mode.row.id}`}
          mode={mode}
          onClose={() => setMode(null)}
          onDone={() => {
            setMode(null);
            setRows(null);
            setReloadKey((k) => k + 1);
          }}
        />
      ) : null}
    </div>
  );
}

// Keyed per return by the parent, so each opening mounts with fresh values.
function ReturnActionDialog({ mode, onClose, onDone }: { mode: Mode; onClose: () => void; onDone: () => void }) {
  // kept: orderItemId → kept qty (defaults to "kept everything");
  // check: orderItemId → damaged qty (good = expected − damaged, defaults to all good)
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(mode.row.items.map((i) => [i.orderItemId, mode.kind === "kept" ? String(i.orderedQty) : "0"])),
  );
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lines = mode.kind === "check" ? mode.row.items.filter((i) => i.expectedBackQty > 0) : mode.row.items;
  const limitFor = (item: CourierReturnRow["items"][number]) => (mode.kind === "kept" ? item.orderedQty : item.expectedBackQty);
  const invalid = lines.some((i) => {
    const v = Number(values[i.orderItemId]);
    return values[i.orderItemId] === "" || !Number.isInteger(v) || v < 0 || v > limitFor(i);
  });

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      if (mode.kind === "kept") {
        await fetchJson(`/api/courier/returns/${mode.row.id}/kept-items`, {
          method: "POST",
          body: JSON.stringify({ kept: lines.map((i) => ({ orderItemId: i.orderItemId, keptQty: Number(values[i.orderItemId]) })) }),
        });
      } else {
        await fetchJson(`/api/courier/returns/${mode.row.id}/check`, {
          method: "POST",
          body: JSON.stringify({
            lines: lines.map((i) => {
              const damaged = Number(values[i.orderItemId]);
              return { orderItemId: i.orderItemId, goodQty: i.expectedBackQty - damaged, damagedQty: damaged };
            }),
            note: note.trim() || undefined,
          }),
        });
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode.kind === "kept" ? "What did the customer keep?" : "Condition check"}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{mode.row.orderNo}</span> —{" "}
            {mode.kind === "kept"
              ? "Enter how many of each item the customer kept. The rest comes back for a condition check, and the order total is adjusted to what was kept."
              : "Check every returned unit. Good units go back into stock; damaged units are written off at cost."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {lines.map((item) => {
            const limit = limitFor(item);
            const v = Number(values[item.orderItemId]);
            return (
              <div key={item.orderItemId} className="flex items-center justify-between gap-3">
                <Label htmlFor={`ret-${item.orderItemId}`} className="flex-col items-start gap-0">
                  <span>{item.productName}</span>
                  <span className="text-xs font-semibold">
                    {item.sizeName} / {item.colorName} · <span className="font-mono font-normal">{item.sku}</span>
                  </span>
                </Label>
                <div className="flex shrink-0 items-center gap-2 text-sm">
                  <span className="text-xs text-muted-foreground">{mode.kind === "kept" ? "Kept" : "Damaged"}</span>
                  <Input
                    id={`ret-${item.orderItemId}`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={limit}
                    className="h-8 w-16"
                    value={values[item.orderItemId] ?? ""}
                    onChange={(e) => setValues((prev) => ({ ...prev, [item.orderItemId]: e.target.value }))}
                  />
                  <span className="w-20 text-xs text-muted-foreground">
                    of {limit}
                    {mode.kind === "check" && Number.isInteger(v) && v >= 0 && v <= limit ? ` · ${limit - v} good` : ""}
                  </span>
                </div>
              </div>
            );
          })}
          {mode.kind === "check" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ret-note">Note (optional)</Label>
              <Textarea id="ret-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. stain on the sleeve" />
            </div>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || invalid}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {mode.kind === "kept" ? "Save kept items" : "Complete check"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
