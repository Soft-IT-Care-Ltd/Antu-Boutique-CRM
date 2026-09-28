"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { CircleAlert, Loader2, Minus, PackageSearch, Plus } from "lucide-react";

import { ScanBox, type ScanResult } from "@/components/scan/scan-box";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { uploadUrl } from "@/lib/catalog/types";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { STOCK_COUNT_SCOPE_LABELS, STOCK_COUNT_STATUS_LABELS, type StockCountLineView, type StockCountView } from "@/lib/stock-counts/constants";
import { STOCK_COUNT_STATUS_TONE } from "@/lib/ui/status-tone";
import { cn } from "@/lib/utils";

type ActionResponse = { count: StockCountView | null; scan: { message: string } | null; result: unknown };

/**
 * C4 — CORRECTIONS.md item 2, stock count by scan. Scan everything on the
 * shelf; each row shows counted vs what the system expects at this
 * location. Posting (a Manager/Admin) books each difference as an
 * adjustment under the Stock shortage rules.
 */
export function StockCountScreen({ initial }: { initial: StockCountView }) {
  const router = useRouter();
  const [c, setC] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"post" | "cancel" | null>(null);
  const [onlyDiff, setOnlyDiff] = useState(false);

  const act = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetchJson<ActionResponse>(`/api/inventory/counts/${c.id}`, { method: "POST", body: JSON.stringify(body) });
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
        const res = await fetchJson<ActionResponse>(`/api/inventory/counts/${c.id}`, { method: "POST", body: JSON.stringify({ action: "scan", code }) });
        if (res.count) setC(res.count);
        return { ok: true, message: res.scan?.message ?? "Counted" };
      } catch (err) {
        return { ok: false, message: err instanceof ApiError ? err.message : "That scan didn't go through — scan it again." };
      }
    },
    [c.id],
  );

  const open = c.status === "OPEN";
  const lines = onlyDiff ? c.lines.filter((l) => l.difference !== 0) : c.lines;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-xl border p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-xl font-semibold">{c.countNo}</h1>
            <Badge variant={STOCK_COUNT_STATUS_TONE[c.status]}>{STOCK_COUNT_STATUS_LABELS[c.status]}</Badge>
          </div>
          <Link href="/inventory/counts" className="text-sm text-muted-foreground hover:underline">
            All counts
          </Link>
        </div>
        <p className="text-base font-medium">
          {c.location.name} <span className="text-sm font-normal text-muted-foreground">· {STOCK_COUNT_SCOPE_LABELS[c.scope].label}</span>
        </p>
        <p className="text-xs text-muted-foreground">{STOCK_COUNT_SCOPE_LABELS[c.scope].hint}</p>
        <p className="text-sm text-muted-foreground">
          Started {formatDhakaDateTime(c.createdAt)}
          {c.createdByName ? ` by ${c.createdByName}` : ""}
          {c.postedAt ? ` · posted ${formatDhakaDateTime(c.postedAt)}${c.postedByName ? ` by ${c.postedByName}` : ""}` : ""}
        </p>
      </div>

      <dl className="grid grid-cols-4 gap-2 text-center">
        {(
          [
            ["Counted", c.totals.counted, ""],
            ["System", c.totals.expected, ""],
            ["Short", c.totals.short, c.totals.short > 0 ? "text-destructive" : ""],
            ["Extra", c.totals.extra, c.totals.extra > 0 ? "text-amber-700 dark:text-amber-400" : ""],
          ] as const
        ).map(([label, value, tone]) => (
          <div key={label} className="rounded-lg bg-muted/60 px-1 py-2">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className={cn("text-lg font-semibold tabular-nums", tone)}>{value}</dd>
          </div>
        ))}
      </dl>

      {c.can.scan ? <ScanBox onScan={onScan} disabled={busy} hint="Scan every dress on the shelf — one scan, one unit." /> : null}

      {error ? (
        <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}

      {c.lines.length > 0 ? (
        <label className="flex items-center gap-2 self-end text-sm">
          <input type="checkbox" className="size-4 accent-primary" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />
          Only differences ({c.totals.itemsWithDifference})
        </label>
      ) : null}

      {lines.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-12 text-center">
          <PackageSearch className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">{c.lines.length === 0 ? "Nothing counted yet" : "No differences"}</p>
          <p className="max-w-sm text-sm text-muted-foreground">{c.lines.length === 0 ? "Scan the first tag to start." : "Everything counted matches the system."}</p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border">
          {lines.map((l) => (
            <CountLineRow key={l.variantId} line={l} editable={c.can.scan} busy={busy} onSetQty={(qty) => act({ action: "setQty", variantId: l.variantId, qty })} />
          ))}
        </ul>
      )}

      {open ? (
        <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-end md:static md:mx-0 md:border-0 md:bg-transparent md:p-0">
          {!c.can.post ? <p className="text-sm text-muted-foreground sm:mr-auto">When you&apos;ve finished, a manager checks and posts the count.</p> : null}
          {c.can.cancel ? (
            <Button variant="outline" disabled={busy} onClick={() => setConfirm("cancel")}>
              Cancel count
            </Button>
          ) : null}
          {c.can.post ? (
            <Button className="h-11" disabled={busy || c.lines.length === 0} onClick={() => setConfirm("post")}>
              Post count ({c.totals.itemsWithDifference} difference{c.totals.itemsWithDifference === 1 ? "" : "s"})
            </Button>
          ) : null}
        </div>
      ) : null}

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm === "post" ? "Post this count?" : "Cancel this count?"}</DialogTitle>
            <DialogDescription>
              {confirm === "post"
                ? `${c.location.name}'s stock is set to what was counted: ${c.totals.short} unit(s) taken off, ${c.totals.extra} added — each at cost under "Stock shortage". ${c.scope === "FULL" ? "Anything there that wasn't scanned is taken off. " : ""}Stock that moved during the count is taken into account.`
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
              {confirm === "post" ? "Post count" : "Cancel count"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CountLineRow({ line: l, editable, busy, onSetQty }: { line: StockCountLineView; editable: boolean; busy: boolean; onSetQty: (qty: number) => void }) {
  return (
    <li className="flex flex-col gap-2 p-3">
      <div className="flex gap-3">
        <div className="flex h-14 w-11 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
          {l.thumbPath ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={uploadUrl(l.thumbPath)} alt="" className="size-full object-cover" />
          ) : (
            <PackageSearch className="size-4 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{l.productName}</p>
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className="size-3 shrink-0 rounded-full border" style={{ backgroundColor: l.colorHex }} />
            <b className="text-foreground">{l.sizeName}</b> · {l.colorName} · <span className="font-mono text-xs">{l.sku}</span>
          </p>
          {!l.scanned ? <p className="text-xs text-amber-700 dark:text-amber-400">Not scanned — counts as none</p> : null}
        </div>
        <div className="flex shrink-0 flex-col items-end justify-center text-right">
          <span className="text-2xl font-semibold tabular-nums">
            {l.counted}
            <span className="text-base font-normal text-muted-foreground">/{l.expected}</span>
          </span>
          <span className={cn("text-xs font-medium", l.difference < 0 ? "text-destructive" : l.difference > 0 ? "text-amber-700 dark:text-amber-400" : "text-emerald-600")}>
            {l.difference === 0 ? "matches" : l.difference < 0 ? `${-l.difference} short` : `${l.difference} extra`}
          </span>
        </div>
      </div>
      {editable ? (
        <div className="flex items-center justify-end gap-1">
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
            className="h-8 w-16 text-center"
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
    </li>
  );
}
