"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { ArrowRight, CircleAlert, Loader2, Minus, PackageSearch, Plus, Search, Send, Trash2, TriangleAlert } from "lucide-react";

import { ScanBox, type ScanResult } from "@/components/scan/scan-box";
import { TransferStatusBadge } from "@/components/transfers/transfer-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { uploadUrl } from "@/lib/catalog/types";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { TransferLineView, TransferView } from "@/lib/transfers/constants";
import { cn } from "@/lib/utils";

type ActionResponse = { transfer: TransferView | null; scan: { message: string } | null; result: unknown };

/**
 * C4 — CORRECTIONS.md item 3. One screen for the whole life of a transfer:
 *   Draft       → the sender scans each dress (one scan = one unit), then Send.
 *   In transit  → the receiver scans each dress as it's unpacked, then Receive.
 *   Difference  → a manager marks each missing unit found or writes it off.
 * Built for a phone held in one hand with a scanner in the other.
 */
export function TransferScreen({ initial }: { initial: TransferView }) {
  const router = useRouter();
  const [t, setT] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"send" | "receive" | "cancel" | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [resolving, setResolving] = useState<{ line: TransferLineView; resolution: "FOUND" | "WRITE_OFF" } | null>(null);

  const side = t.status === "DRAFT" ? "send" : "receive";
  const scanning = t.can.editSend || t.can.receive;

  const act = useCallback(
    async (body: Record<string, unknown>, label: string) => {
      setBusy(label);
      setError(null);
      try {
        const res = await fetchJson<ActionResponse>(`/api/inventory/transfers/${t.id}`, { method: "POST", body: JSON.stringify(body) });
        if (res.transfer) setT(res.transfer);
        return res;
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "That didn't go through — try again.");
        return null;
      } finally {
        setBusy(null);
      }
    },
    [t.id],
  );

  const onScan = useCallback(
    async (code: string): Promise<ScanResult> => {
      try {
        const res = await fetchJson<ActionResponse>(`/api/inventory/transfers/${t.id}`, { method: "POST", body: JSON.stringify({ action: "scan", side, code }) });
        if (res.transfer) setT(res.transfer);
        return { ok: true, message: res.scan?.message ?? "Scanned" };
      } catch (err) {
        return { ok: false, message: err instanceof ApiError ? err.message : "That scan didn't go through — scan it again." };
      }
    },
    [t.id, side],
  );

  const received = t.status === "RECEIVED" || t.status === "RECEIVED_WITH_DIFFERENCE";
  const lines = t.lines.filter((l) => t.status === "DRAFT" || l.qtySent > 0);
  const progress = t.status === "DRAFT" ? null : t.status === "IN_TRANSIT" ? { done: t.totals.scannedIn, of: t.totals.sent } : { done: t.totals.received + t.totals.found, of: t.totals.sent };
  const overSource = t.status === "DRAFT" && t.lines.some((l) => l.atSource !== null && l.qtySent > l.atSource);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-xl border p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-xl font-semibold">{t.transferNo}</h1>
            <TransferStatusBadge status={t.status} />
          </div>
          <Link href="/inventory/transfers" className="text-sm text-muted-foreground hover:underline">
            All transfers
          </Link>
        </div>
        <div className="flex items-center gap-2 text-base">
          <span className="font-medium">{t.from.name}</span>
          <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">{t.to.name}</span>
          {t.to.isPackingHub ? <Badge variant="outline">Packing hub</Badge> : null}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Created</dt>
            <dd>
              {formatDhakaDateTime(t.createdAt)}
              {t.createdByName ? <span className="text-muted-foreground"> · {t.createdByName}</span> : null}
            </dd>
          </div>
          {t.sentAt ? (
            <div>
              <dt className="text-xs text-muted-foreground">Sent</dt>
              <dd>
                {formatDhakaDateTime(t.sentAt)}
                {t.sentByName ? <span className="text-muted-foreground"> · {t.sentByName}</span> : null}
              </dd>
            </div>
          ) : null}
          {t.receivedAt ? (
            <div>
              <dt className="text-xs text-muted-foreground">Received</dt>
              <dd>
                {formatDhakaDateTime(t.receivedAt)}
                {t.receivedByName ? <span className="text-muted-foreground"> · {t.receivedByName}</span> : null}
              </dd>
            </div>
          ) : null}
          {t.cancelledAt ? (
            <div className="col-span-2">
              <dt className="text-xs text-muted-foreground">Cancelled</dt>
              <dd>
                {formatDhakaDateTime(t.cancelledAt)} — {t.cancelReason}
              </dd>
            </div>
          ) : null}
        </dl>
        {t.orders.length > 0 ? (
          <p className="text-sm">
            <span className="text-muted-foreground">For orders waiting at the hub: </span>
            {t.orders.map((o, i) => (
              <span key={o.id}>
                {i > 0 ? ", " : ""}
                <Link href={`/orders/${o.id}`} className="font-mono hover:underline">
                  {o.orderNo}
                </Link>
              </span>
            ))}
          </p>
        ) : null}
        {t.note ? <p className="text-sm text-muted-foreground">{t.note}</p> : null}
      </div>

      {progress ? (
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-sm">
            <span className="font-medium">{t.status === "IN_TRANSIT" ? "Scanned in" : "Arrived"}</span>
            <span className="tabular-nums">
              <b>{progress.done}</b> of {progress.of}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full rounded-full transition-all", progress.done === progress.of ? "bg-emerald-600" : "bg-primary")} style={{ width: `${progress.of ? (100 * progress.done) / progress.of : 0}%` }} />
          </div>
        </div>
      ) : null}

      {scanning ? (
        <ScanBox
          onScan={onScan}
          disabled={busy !== null}
          hint={t.status === "DRAFT" ? `Scan each dress as it goes in the bag — one scan, one unit. It leaves ${t.from.name} when you press Send.` : `Scan each dress as you unpack it. Only what's scanned goes into ${t.to.name}'s stock.`}
        />
      ) : null}

      {t.status === "RECEIVED_WITH_DIFFERENCE" && t.totals.missing > 0 ? (
        <div className="flex items-start gap-2 rounded-xl border-2 border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <p>
            <b>{t.totals.missing} unit(s) missing in transit.</b> They count in total stock but aren&apos;t at any location until a manager marks them found or writes them off.
            {!t.can.resolve ? " A manager resolves them." : ""}
          </p>
        </div>
      ) : null}

      {error ? (
        <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}

      {lines.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-12 text-center">
          <PackageSearch className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">Nothing scanned yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">Scan the first tag — the list builds up as you go.</p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border">
          {lines.map((l) => (
            <TransferLineRow
              key={l.variantId}
              line={l}
              t={t}
              busy={busy !== null}
              onSetQty={(qty) => act({ action: "setQty", side, variantId: l.variantId, qty }, "qty")}
              onResolve={(resolution) => setResolving({ line: l, resolution })}
            />
          ))}
        </ul>
      )}

      <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-end md:static md:mx-0 md:border-0 md:bg-transparent md:p-0">
        {t.status === "DRAFT" ? (
          <p className="text-sm text-muted-foreground sm:mr-auto">
            <b className="text-foreground tabular-nums">{t.totals.sent}</b> unit(s) scanned{t.totals.requested ? <> · {t.totals.requested} asked for</> : null}
          </p>
        ) : null}
        {t.can.cancel ? (
          <Button variant="outline" onClick={() => setConfirm("cancel")} disabled={busy !== null}>
            <Trash2 /> Cancel transfer
          </Button>
        ) : null}
        {t.can.editSend ? (
          <Button size="lg" className="h-11" onClick={() => setConfirm("send")} disabled={busy !== null || !t.can.send || overSource}>
            <Send /> Send {t.totals.sent > 0 ? `${t.totals.sent} unit(s)` : ""}
          </Button>
        ) : null}
        {t.can.receive ? (
          <Button size="lg" className="h-11" onClick={() => setConfirm("receive")} disabled={busy !== null}>
            Receive {t.totals.scannedIn} of {t.totals.sent}
          </Button>
        ) : null}
        {t.status === "IN_TRANSIT" && !t.can.receive ? <p className="text-sm text-muted-foreground">On its way — {t.to.name} scans it in.</p> : null}
        {received && t.totals.missing === 0 ? <p className="text-sm text-muted-foreground">All {t.totals.sent} unit(s) accounted for.</p> : null}
      </div>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm === "send" ? `Send ${t.totals.sent} unit(s)?` : confirm === "receive" ? `Receive ${t.totals.scannedIn} unit(s)?` : "Cancel this transfer?"}</DialogTitle>
            <DialogDescription>
              {confirm === "send"
                ? `They leave ${t.from.name}'s stock now and show as in transit until ${t.to.name} scans them in.`
                : confirm === "receive"
                  ? t.totals.scannedIn < t.totals.sent
                    ? `${t.totals.sent - t.totals.scannedIn} unit(s) weren't scanned. They'll stay "missing in transit" until a manager marks them found or writes them off.`
                    : `Everything sent was scanned. It goes into ${t.to.name}'s stock now.`
                  : "Nothing has moved yet — the draft is closed."}
            </DialogDescription>
          </DialogHeader>
          {confirm === "cancel" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cancel-reason">Why?</Label>
              <Textarea id="cancel-reason" rows={2} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Back
            </Button>
            <Button
              variant={confirm === "cancel" ? "destructive" : confirm === "receive" && t.totals.scannedIn < t.totals.sent ? "destructive" : "default"}
              disabled={busy !== null || (confirm === "cancel" && cancelReason.trim().length < 3)}
              onClick={async () => {
                const which = confirm!;
                const res = await act(which === "cancel" ? { action: "cancel", reason: cancelReason } : { action: which }, which);
                if (res) {
                  setConfirm(null);
                  router.refresh();
                }
              }}
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              {confirm === "send" ? "Send now" : confirm === "receive" ? (t.totals.scannedIn < t.totals.sent ? "Receive with difference" : "Receive") : "Cancel transfer"}
            </Button>
          </DialogFooter>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </DialogContent>
      </Dialog>

      <ResolveDialog
        resolving={resolving}
        busy={busy !== null}
        error={error}
        onClose={() => setResolving(null)}
        onSubmit={async (qty, reason) => {
          if (!resolving) return;
          const res = await act({ action: "resolve", variantId: resolving.line.variantId, resolution: resolving.resolution, qty, reason }, "resolve");
          if (res) setResolving(null);
        }}
        toName={t.to.name}
      />
    </div>
  );
}

function Thumb({ path }: { path: string | null }) {
  return (
    <div className="flex h-14 w-11 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
      {path ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={uploadUrl(path)} alt="" className="size-full object-cover" />
      ) : (
        <Search className="size-4 text-muted-foreground" />
      )}
    </div>
  );
}

function TransferLineRow({
  line: l,
  t,
  busy,
  onSetQty,
  onResolve,
}: {
  line: TransferLineView;
  t: TransferView;
  busy: boolean;
  onSetQty: (qty: number) => void;
  onResolve: (resolution: "FOUND" | "WRITE_OFF") => void;
}) {
  const draft = t.status === "DRAFT";
  const inTransit = t.status === "IN_TRANSIT";
  const editable = (draft && t.can.editSend) || (inTransit && t.can.receive);
  const count = draft ? l.qtySent : inTransit ? l.qtyScannedIn : l.qtyReceived + l.qtyFound;
  const target = draft ? l.qtyRequested || null : l.qtySent;
  const over = draft && l.atSource !== null && l.qtySent > l.atSource;
  const complete = target !== null && count === target;

  return (
    <li className="flex flex-col gap-2 p-3">
      <div className="flex gap-3">
        <Thumb path={l.thumbPath} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{l.productName}</p>
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className="size-3 shrink-0 rounded-full border" style={{ backgroundColor: l.colorHex }} />
            <b className="text-foreground">{l.sizeName}</b> · {l.colorName} · <span className="font-mono text-xs">{l.sku}</span>
          </p>
          {draft && l.atSource !== null ? (
            <p className={cn("text-xs", over ? "font-medium text-destructive" : "text-muted-foreground")}>
              {l.atSource} at {t.from.name}
              {over ? " — fewer than scanned" : ""}
            </p>
          ) : null}
          {l.unitCost ? <p className="text-xs text-muted-foreground">Cost {formatBDT(l.unitCost)} each</p> : null}
        </div>
        <div className="flex shrink-0 flex-col items-end justify-center">
          <span className={cn("text-2xl font-semibold tabular-nums", complete ? "text-emerald-600" : "")}>
            {count}
            {target !== null ? <span className="text-base font-normal text-muted-foreground">/{target}</span> : null}
          </span>
          <span className="text-xs text-muted-foreground">{draft ? (l.qtyRequested ? "scanned / asked" : "scanned") : inTransit ? "scanned / sent" : "arrived / sent"}</span>
        </div>
      </div>

      {editable ? (
        <div className="flex items-center justify-end gap-1">
          <Button variant="outline" size="icon" aria-label={`One fewer ${l.sku}`} disabled={busy || count === 0} onClick={() => onSetQty(count - 1)}>
            <Minus />
          </Button>
          <Input
            key={count}
            type="number"
            inputMode="numeric"
            min={0}
            defaultValue={count}
            aria-label={`Quantity of ${l.sku}`}
            className="h-8 w-16 text-center"
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 0 && n !== count) onSetQty(n);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <Button variant="outline" size="icon" aria-label={`One more ${l.sku}`} disabled={busy || (inTransit && count >= l.qtySent)} onClick={() => onSetQty(count + 1)}>
            <Plus />
          </Button>
        </div>
      ) : null}

      {!draft && !inTransit && (l.qtyFound > 0 || l.qtyWrittenOff > 0 || l.missing > 0) ? (
        <div className="flex flex-wrap items-center justify-end gap-2 text-sm">
          {l.qtyFound > 0 ? <Badge variant="success">{l.qtyFound} found later</Badge> : null}
          {l.qtyWrittenOff > 0 ? <Badge variant="outline">{l.qtyWrittenOff} written off</Badge> : null}
          {l.missing > 0 ? <Badge variant="destructive">{l.missing} missing</Badge> : null}
          {l.missing > 0 && t.can.resolve ? (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onResolve("FOUND")}>
                Found
              </Button>
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => onResolve("WRITE_OFF")}>
                Write off
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function ResolveDialog({
  resolving,
  busy,
  error,
  onClose,
  onSubmit,
  toName,
}: {
  resolving: { line: TransferLineView; resolution: "FOUND" | "WRITE_OFF" } | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (qty: number, reason: string) => void;
  toName: string;
}) {
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const found = resolving?.resolution === "FOUND";
  const max = resolving?.line.missing ?? 0;
  const n = Number(qty);
  const valid = Number.isInteger(n) && n >= 1 && n <= max && reason.trim().length >= 3;

  return (
    <Dialog
      open={resolving !== null}
      onOpenChange={(o) => {
        if (!o) {
          setQty("1");
          setReason("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{found ? "Found — receive it now" : "Write off as lost in transit"}</DialogTitle>
          {resolving ? (
            <DialogDescription>
              {resolving.line.productName} — <b className="text-foreground">{resolving.line.sizeName} / {resolving.line.colorName}</b> ({resolving.line.sku}). {max} missing.{" "}
              {found ? `It goes into ${toName}'s stock.` : `It leaves stock for good; its cost is booked under "Stock shortage".`}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-[6rem_1fr]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="resolve-qty">Quantity</Label>
            <Input id="resolve-qty" type="number" inputMode="numeric" min={1} max={max} value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="resolve-reason">{found ? "Where was it?" : "What happened?"}</Label>
            <Textarea id="resolve-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Back
          </Button>
          <Button variant={found ? "default" : "destructive"} disabled={busy || !valid} onClick={() => onSubmit(n, reason)}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {found ? "Receive" : "Write off"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
