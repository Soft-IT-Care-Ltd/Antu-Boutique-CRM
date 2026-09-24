"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { ORDER_STATUS_LABELS } from "@/lib/orders/constants";
import { COURIER_CHARGE_BEARER_LABELS, RETURN_CASE_MODE_LABELS, RETURN_CASE_STATUS_LABELS, RETURN_CASE_TYPE_LABELS, RETURN_REASON_LABELS } from "@/lib/returns/constants";
import type { ReturnCaseView, VariantLabel } from "@/lib/returns/types";

export type CaseActions = {
  /** Holds return.approve / exchange.approve for this case's type. */
  canApprove: (c: ReturnCaseView) => boolean;
  /** Holds return.create / exchange.create for this case's type. */
  canRequest: (c: ReturnCaseView) => boolean;
};

type Pending = { kind: "approve" | "reject" | "cancel"; returnCase: ReturnCaseView };

const STATUS_VARIANT = { REQUESTED: "secondary", APPROVED: "default", COMPLETED: "outline", REJECTED: "destructive", CANCELLED: "outline" } as const;

function Variant({ v }: { v: VariantLabel }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="size-2.5 shrink-0 rounded-full border" style={{ backgroundColor: v.hexCode }} />
      {v.product} <b>{v.size} / {v.color}</b>
    </span>
  );
}

// PRD §4.11 — one return or exchange: what's coming back, what goes out
// instead, why, who asked and decided, and where it stands. Both linked
// orders are one click away.
export function ReturnCaseCard({ returnCase: c, actions, onChanged, showOrder = true }: { returnCase: ReturnCaseView; actions: CaseActions; onChanged: () => void; showOrder?: boolean }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const canDecide = c.status === "REQUESTED" && actions.canApprove(c) && !c.isMine;
  const canCancel =
    (c.status === "REQUESTED" && (c.isMine ? actions.canRequest(c) : actions.canApprove(c))) || (c.status === "APPROVED" && c.mode === "ONLINE" && actions.canApprove(c) && !c.itemChecked);

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={c.type === "EXCHANGE" ? "default" : "secondary"}>{RETURN_CASE_TYPE_LABELS[c.type]}</Badge>
        <Badge variant="outline">{RETURN_CASE_MODE_LABELS[c.mode]}</Badge>
        <Badge variant={STATUS_VARIANT[c.status]}>{RETURN_CASE_STATUS_LABELS[c.status]}</Badge>
        {showOrder ? (
          <Link href={`/orders/${c.order.id}`} className="font-mono font-medium hover:underline">
            {c.order.orderNo}
          </Link>
        ) : null}
        {showOrder ? (
          <span className="text-muted-foreground">
            · {c.order.customerName}
            {c.order.customerPhone ? ` · ${c.order.customerPhone}` : ""}
          </span>
        ) : null}
      </div>

      <ul className="flex flex-col gap-1">
        {c.lines.map((l) => (
          <li key={l.orderItemId} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="tabular-nums">{l.qty} ×</span>
            <Variant v={l.item} />
            {l.replacement ? (
              <>
                <ArrowRight className="size-3.5 text-muted-foreground" aria-label="exchanged for" />
                <Variant v={l.replacement} />
              </>
            ) : null}
            {l.goodQty !== null ? (
              <span className="text-xs text-muted-foreground">
                · checked: {l.goodQty} good{l.damagedQty ? `, ${l.damagedQty} damaged` : ""}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <p>
        <span className="text-muted-foreground">Reason:</span> <b>{RETURN_REASON_LABELS[c.reason]}</b>
        {c.reasonNote ? ` — ${c.reasonNote}` : ""}
        {c.courierChargeBearer ? <span className="text-muted-foreground"> · {COURIER_CHARGE_BEARER_LABELS[c.courierChargeBearer]}</span> : null}
      </p>

      {c.replacementOrder ? (
        <p>
          <span className="text-muted-foreground">Replacement:</span>{" "}
          <Link href={`/orders/${c.replacementOrder.id}`} className="font-mono font-medium hover:underline">
            {c.replacementOrder.orderNo}
          </Link>{" "}
          · {ORDER_STATUS_LABELS[c.replacementOrder.status]}
          {Number(c.replacementOrder.dueAmount) > 0 ? ` · customer owes ${formatBDT(c.replacementOrder.dueAmount)}` : ""}
        </p>
      ) : null}
      {c.status === "APPROVED" && c.mode === "ONLINE" ? <p className="text-amber-700 dark:text-amber-400">Waiting for the item to come back — Packing checks it on the Courier page, then stock moves.</p> : null}
      {Number(c.refundRequested) > 0 ? <p>Refund requested: {formatBDT(c.refundRequested)} (approved on the order&apos;s payments)</p> : null}

      <p className="text-xs text-muted-foreground">
        Asked by {c.requestedBy ?? "—"} · {formatDhakaDateTime(c.requestedAt)}
        {c.decidedBy && c.mode === "ONLINE" ? ` · ${c.status === "REJECTED" ? "rejected" : "approved"} by ${c.decidedBy}${c.decidedAt ? ` · ${formatDhakaDateTime(c.decidedAt)}` : ""}` : ""}
        {c.decisionNote && c.mode === "ONLINE" ? ` — "${c.decisionNote}"` : ""}
        {c.cancelledBy ? ` · cancelled by ${c.cancelledBy} — "${c.cancelNote}"` : ""}
        {c.completedAt ? ` · done ${formatDhakaDateTime(c.completedAt)}` : ""}
      </p>

      {canDecide || canCancel ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {canDecide ? (
            <>
              <Button size="sm" onClick={() => setPending({ kind: "approve", returnCase: c })}>
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPending({ kind: "reject", returnCase: c })}>
                Reject
              </Button>
            </>
          ) : null}
          {canCancel ? (
            <Button size="sm" variant="ghost" onClick={() => setPending({ kind: "cancel", returnCase: c })}>
              {c.status === "REQUESTED" ? "Withdraw" : "Cancel"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {pending ? (
        <CaseActionDialog
          pending={pending}
          onClose={() => setPending(null)}
          onDone={() => {
            setPending(null);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function CaseActionDialog({ pending, onClose, onDone }: { pending: Pending; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const c = pending.returnCase;
  const kind = RETURN_CASE_TYPE_LABELS[c.type].toLowerCase();
  const noteRequired = pending.kind !== "approve";

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      if (pending.kind === "cancel") {
        await fetchJson(`/api/returns/${c.id}/cancel`, { method: "POST", body: JSON.stringify({ note }) });
        onDone();
        return;
      }
      const result = await fetchJson<{ replacementOrderNo?: string | null; owedToCustomer?: string }>(`/api/returns/${c.id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: pending.kind === "approve" ? "APPROVE" : "REJECT", note: note.trim() || null }),
      });
      if (pending.kind === "approve" && (result.replacementOrderNo || Number(result.owedToCustomer) > 0)) {
        setDone(
          [
            result.replacementOrderNo ? `Replacement order ${result.replacementOrderNo} is confirmed and in the packing queue.` : null,
            Number(result.owedToCustomer) > 0 ? `The customer is owed ${formatBDT(result.owedToCustomer!)} on ${c.order.orderNo} — Accounts refunds it from the order's payments.` : null,
          ]
            .filter(Boolean)
            .join(" "),
        );
        return;
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  const title = pending.kind === "approve" ? `Approve this ${kind}?` : pending.kind === "reject" ? `Reject this ${kind}?` : c.status === "REQUESTED" ? `Withdraw this ${kind} request?` : `Cancel this ${kind}?`;
  const description =
    pending.kind === "approve"
      ? c.type === "EXCHANGE"
        ? "A replacement order is created and reserved now; the returned item goes back into stock only after Packing checks it."
        : "The items are marked as returned and the order total drops by their value; stock moves only after Packing checks them."
      : pending.kind === "reject"
        ? "The executive sees your reason."
        : c.status === "APPROVED"
          ? "The replacement is cancelled, the credit and the returned units are taken back, and the order goes back to where it was."
          : "The request is closed without any change.";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{c.order.orderNo}</span> — {description}
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <p className="text-sm">{done}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="case-note">{noteRequired ? "Reason" : "Note (optional)"}</Label>
            <Textarea id="case-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
        )}
        <DialogFooter>
          {done ? (
            <Button onClick={onDone}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={saving}>
                Back
              </Button>
              <Button variant={pending.kind === "approve" ? "default" : "destructive"} onClick={submit} disabled={saving || (noteRequired && note.trim().length < 3)}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {pending.kind === "approve" ? "Approve" : pending.kind === "reject" ? "Reject" : c.status === "REQUESTED" ? "Withdraw" : "Cancel it"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
