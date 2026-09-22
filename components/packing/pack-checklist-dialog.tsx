"use client";

import { useState } from "react";
import { Loader2, PackageCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { PACKING_CHECKLIST_KEYS } from "@/lib/packing/types";
import type { PackingChecklist, PackingOrderDetail } from "@/lib/packing/types";

const CHECKLIST_LABELS: Record<(typeof PACKING_CHECKLIST_KEYS)[number], string> = {
  itemsMatch: "Items match the order lines",
  imageMatched: "Image matched — physical item confirmed against the customer's photo",
  qualityChecked: "Quality checked (no defect, no stain)",
  invoicePrinted: "Invoice printed and inserted",
};

const EMPTY_CHECKLIST: PackingChecklist = {
  itemsMatch: false,
  imageMatched: false,
  qualityChecked: false,
  invoicePrinted: false,
};

// PRD §4.8: "packing checklist required before marking PACKED." All four
// must be checked before the button enables — the server independently
// re-validates every key (see app/api/packing/[orderId]/pack/route.ts),
// this is just the UI guardrail.
export function PackChecklistDialog({ orderId, onPacked }: { orderId: string; onPacked: (order: PackingOrderDetail) => void }) {
  const [open, setOpen] = useState(false);
  const [checklist, setChecklist] = useState<PackingChecklist>(EMPTY_CHECKLIST);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allChecked = PACKING_CHECKLIST_KEYS.every((key) => checklist[key]);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const { order } = await fetchJson<{ order: PackingOrderDetail }>(`/api/packing/${orderId}/pack`, {
        method: "POST",
        body: JSON.stringify({ checklist, note: note.trim() || undefined }),
      });
      onPacked(order);
      setOpen(false);
      setChecklist(EMPTY_CHECKLIST);
      setNote("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not mark this order packed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <PackageCheck />
        Mark packed
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Packing checklist</DialogTitle>
          <DialogDescription>Confirm every item before this order moves to Packed — stock is deducted immediately.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {PACKING_CHECKLIST_KEYS.map((key) => (
            <Label key={key} className="flex items-start gap-2 text-sm font-normal">
              <Checkbox checked={checklist[key]} onCheckedChange={(v) => setChecklist((c) => ({ ...c, [key]: Boolean(v) }))} className="mt-0.5" />
              {CHECKLIST_LABELS[key]}
            </Label>
          ))}
          <Textarea placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={submit} disabled={!allChecked || saving}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            Mark packed
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
