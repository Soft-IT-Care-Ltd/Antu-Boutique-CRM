"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { ORDER_STATUS_LABELS } from "@/lib/orders/constants";
import { COURIER_OWNED_STATUSES, nextSelectableStatuses } from "@/lib/orders/status-graph";
import type { OrderStatusValue } from "@/lib/orders/constants";
import type { OrderDetail } from "@/lib/orders/types";

// PRD §4.6 lifecycle. Computes legal next statuses from the order's CURRENT
// status (client state, via lib/orders/status-graph.ts — the same table
// the API route enforces) rather than a one-shot server prop, so the
// option list stays correct across repeated changes without a page reload.
export function OrderStatusControl({
  order,
  onChange,
  courierBooked = false,
}: {
  order: OrderDetail;
  onChange: (order: OrderDetail) => void;
  /** A Steadfast consignment exists: its delivery statuses come from the courier sync, not this control. */
  courierBooked?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [toStatus, setToStatus] = useState<OrderStatusValue | "">("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextStatuses = nextSelectableStatuses(order.status).filter((s) => !(courierBooked && COURIER_OWNED_STATUSES.includes(s)));
  if (nextStatuses.length === 0) return null;

  async function submit() {
    if (!toStatus) return;
    setSaving(true);
    setError(null);
    try {
      const { order: updated } = await fetchJson<{ order: OrderDetail }>(`/api/orders/${order.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ toStatus, note: note.trim() || undefined }),
      });
      onChange(updated);
      setOpen(false);
      setToStatus("");
      setNote("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update status.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>Change status</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change order status</DialogTitle>
          <DialogDescription>
            Currently <strong>{ORDER_STATUS_LABELS[order.status]}</strong>. This is written to the order&apos;s status history.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Select value={toStatus} onValueChange={(v) => setToStatus(v as OrderStatusValue)}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="New status">{(value: string) => ORDER_STATUS_LABELS[value as OrderStatusValue]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {nextStatuses.map((s) => (
                <SelectItem key={s} value={s}>
                  {ORDER_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={submit} disabled={!toStatus || saving}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            Update status
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
