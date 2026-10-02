"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { CircleAlert, Loader2, Minus, PackageSearch, Plus } from "lucide-react";

import { ScanBox, type ScanResult } from "@/components/scan/scan-box";
import { ItemRow } from "@/components/shelves/shelves-screen";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { ShelfCountLineView, ShelfCountView } from "@/lib/shelves/constants";
import { cn } from "@/lib/utils";

type ActionResponse = { count: ShelfCountView | null; scan: { message: string } | null; result: unknown };

const STATUS_LABEL = { OPEN: "Counting", DONE: "Finished", CANCELLED: "Cancelled" } as const;

/**
 * C4b — CORRECTIONS.md item 20A, counting one shelf: scan everything on it.
 * Each item is compared with the shelf when it was scanned, so a sale or a
 * move during the count never shows as a difference. Finishing moves
 * missing units to "not on its shelf" and brings extra ones from
 * Unassigned — it never changes stock.
 */
export function ShelfCountScreen({ initial }: { initial: ShelfCountView }) {
  const router = useRouter();
  const [c, setC] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"finish" | "cancel" | null>(null);

  const act = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetchJson<ActionResponse>(`/api/inventory/shelves/counts/${c.id}`, { method: "POST", body: JSON.stringify(body) });
        if (res.count) setC(res.count);
        return res;
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "That didn't go through — try again.");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [c.id],
  );

  const onScan = useCallback(
    async (code: string): Promise<ScanResult> => {
      try {
        const res = await fetchJson<ActionResponse>(`/api/inventory/shelves/counts/${c.id}`, { method: "POST", body: JSON.stringify({ action: "scan", code }) });
        if (res.count) setC(res.count);
        return { ok: true, message: res.scan?.message ?? "Counted" };
      } catch (err) {
        return { ok: false, message: err instanceof ApiError ? err.message : "That scan didn't go through — scan it again." };
      }
    },
    [c.id],
  );

  const open = c.status === "OPEN";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-xl border p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-xl font-semibold">Shelf {c.shelf.code}</h1>
            <Badge variant={open ? "secondary" : "outline"}>{STATUS_LABEL[c.status]}</Badge>
          </div>
          <Link href={`/inventory/shelves/${c.shelf.id}`} className="text-sm text-muted-foreground hover:underline">
            Back to the shelf
          </Link>
        </div>
        <p className="text-base">{c.location.name}</p>
        <p className="text-sm text-muted-foreground">
          Started {formatDhakaDateTime(c.createdAt)}
          {c.createdByName ? ` by ${c.createdByName}` : ""}
          {c.finishedAt ? ` · finished ${formatDhakaDateTime(c.finishedAt)}${c.finishedByName ? ` by ${c.finishedByName}` : ""}` : ""}
        </p>
      </div>

      <dl className="grid grid-cols-4 gap-2 text-center">
        {(
          [
            ["Counted", c.totals.counted, ""],
            ["System", c.totals.expected, ""],
            ["Missing", c.totals.missing, c.totals.missing > 0 ? "text-destructive" : ""],
            ["Extra", c.totals.extra, c.totals.extra > 0 ? "text-amber-700 dark:text-amber-400" : ""],
          ] as const
        ).map(([label, value, tone]) => (
          <div key={label} className="rounded-lg bg-muted/60 px-1 py-2">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className={cn("text-lg font-semibold tabular-nums", tone)}>{value}</dd>
          </div>
        ))}
      </dl>

      {c.can.scan ? <ScanBox onScan={onScan} disabled={busy} hint={`Scan every dress on ${c.shelf.code} — one scan, one unit.`} /> : null}

      {error ? (
        <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}

      {c.lines.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-12 text-center">
          <PackageSearch className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">Nothing on this shelf yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">Scan the first tag to start.</p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border">
          {c.lines.map((l) => (
            <ItemRow key={l.variantId} line={{ ...l, qty: l.counted }} sub={lineNote(l, open)} right={<LineFigures line={l} editable={c.can.scan} busy={busy} onSetQty={(qty) => act({ action: "setQty", variantId: l.variantId, qty })} />} />
          ))}
        </ul>
      )}

      {open && c.can.finish ? (
        <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-end md:static md:mx-0 md:border-0 md:bg-transparent md:p-0">
          <Button variant="outline" disabled={busy} onClick={() => setConfirm("cancel")}>
            Cancel count
          </Button>
          <Button className="h-11" disabled={busy} onClick={() => setConfirm("finish")}>
            Finish count
          </Button>
        </div>
      ) : null}

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm === "finish" ? `Finish counting ${c.shelf.code}?` : "Cancel this count?"}</DialogTitle>
            <DialogDescription>
              {confirm === "finish"
                ? `${c.totals.missing} unit(s) not found go to "not on its shelf" for the manager — they stay in stock (the dress may be on another shelf). ${c.totals.extra} extra unit(s) are brought onto this shelf from Unassigned or the shelf they were thought to be on. Stock doesn't change.`
                : "Nothing changes — the scans are thrown away."}
            </DialogDescription>
          </DialogHeader>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Back
            </Button>
            <Button
              variant={confirm === "cancel" ? "destructive" : "default"}
              disabled={busy}
              onClick={async () => {
                const res = await act({ action: confirm });
                if (res) {
                  setConfirm(null);
                  router.refresh();
                }
              }}
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              {confirm === "finish" ? "Finish count" : "Cancel count"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function lineNote(l: ShelfCountLineView, open: boolean): string | undefined {
  if (l.movedDuringCount) return "Not scanned, and it moved on this shelf during the count — left as it is. Scan it to count it.";
  if (open && !l.scanned) return "Not scanned — counts as none";
  if (l.result) {
    const parts = [l.result.missing ? `${l.result.missing} to "not on its shelf"` : "", l.result.placed ? `${l.result.placed} brought onto the shelf` : "", l.result.unplaced ? `${l.result.unplaced} more than the location's stock — needs a location count` : ""].filter(Boolean);
    return parts.length ? parts.join(" · ") : undefined;
  }
  return undefined;
}

function LineFigures({ line: l, editable, busy, onSetQty }: { line: ShelfCountLineView; editable: boolean; busy: boolean; onSetQty: (qty: number) => void }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <span className="text-2xl font-semibold tabular-nums">
        {l.counted}
        <span className="text-base font-normal text-muted-foreground">/{l.expected}</span>
      </span>
      <span className={cn("text-xs font-medium", l.difference < 0 ? "text-destructive" : l.difference > 0 || l.movedDuringCount ? "text-amber-700 dark:text-amber-400" : "text-emerald-600")}>
        {l.movedDuringCount ? "not changed" : l.difference === 0 ? "matches" : l.difference < 0 ? `${-l.difference} missing` : `${l.difference} extra`}
      </span>
      {editable ? (
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" aria-label={`One fewer ${l.sku}`} disabled={busy || l.counted === 0} onClick={() => onSetQty(l.counted - 1)}>
            <Minus />
          </Button>
          <Input
            key={l.counted}
            type="number"
            inputMode="numeric"
            min={0}
            defaultValue={l.counted}
            aria-label={`Counted ${l.sku}`}
            className="h-8 w-14 text-center"
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 0 && n !== l.counted) onSetQty(n);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <Button variant="outline" size="icon" aria-label={`One more ${l.sku}`} disabled={busy} onClick={() => onSetQty(l.counted + 1)}>
            <Plus />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
