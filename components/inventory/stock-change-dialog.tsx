"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import type { StockReportRow } from "@/lib/inventory/types";
import type { LocationOption } from "@/lib/locations/constants";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatBDT } from "@/lib/money";

export type StockChangeMode = "adjust" | "write-off";

type Props = {
  mode: StockChangeMode;
  row: StockReportRow | null;
  /** C3 — where the correction happens: only locations this user acts for. */
  locations: LocationOption[];
  /** The stock report's location filter, if any — picked first when allowed. */
  preferredLocationId: string | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
};

/**
 * PRD §4.3: manual adjustment (signed, reason required) and damage
 * write-off (DAMAGE_OUT + expense at cost). Only rendered for users with
 * inventory.adjust — the API enforces the same permission.
 */
export function StockChangeDialog({ mode, row, locations, preferredLocationId, onOpenChange, onDone }: Props) {
  const [direction, setDirection] = useState<"add" | "remove">("remove");
  // Default: the filtered location, else where this variant has the most.
  const defaultLocationId = (() => {
    if (preferredLocationId && locations.some((l) => l.id === preferredLocationId)) return preferredLocationId;
    const held = [...(row?.byLocation ?? [])].sort((a, b) => b.qty - a.qty).find((b) => locations.some((l) => l.id === b.locationId));
    return held?.locationId ?? locations[0]?.id ?? "";
  })();
  const [pickedLocationId, setPickedLocationId] = useState<string | null>(null);
  const locationId = pickedLocationId ?? defaultLocationId;
  const atLocation = row?.byLocation.find((b) => b.locationId === locationId)?.qty ?? 0;
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const qtyNumber = Number(qty);
  const qtyValid = Number.isInteger(qtyNumber) && qtyNumber > 0;
  const signedQty = mode === "adjust" && direction === "remove" ? -qtyNumber : qtyNumber;
  const resultingStock = row && qtyValid ? atLocation + (mode === "write-off" ? -qtyNumber : signedQty) : null;
  // A removal can't take the location below zero; adding to one already
  // negative (a POS sale, CORRECTIONS.md item 11) is how it's put right.
  const goesNegative = resultingStock !== null && resultingStock < 0 && (mode === "write-off" || direction === "remove");

  function reset() {
    setDirection("remove");
    setQty("1");
    setReason("");
    setError(null);
    setPickedLocationId(null);
  }

  async function submit() {
    if (!row) return;
    setSaving(true);
    setError(null);
    try {
      await fetchJson(mode === "adjust" ? "/api/inventory/adjustments" : "/api/inventory/write-offs", {
        method: "POST",
        body: JSON.stringify({ variantId: row.variantId, locationId, qty: signedQty, reason }),
      });
      reset();
      onOpenChange(false);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) reset();
        onOpenChange(open);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "adjust" ? "Adjust stock" : "Write off damaged stock"}</DialogTitle>
          {row ? (
            <DialogDescription>
              {row.productName} — <span className="font-semibold text-foreground">{row.sizeName} / {row.colorName}</span>{" "}
              <span className="font-mono">({row.sku})</span>. {row.stockQty} on hand in all, {row.reservedQty} reserved.
            </DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Location</Label>
            {locations.length === 0 ? (
              <p className="text-sm text-destructive">You aren&apos;t assigned to any location — ask an Admin to assign you in Settings → Locations.</p>
            ) : (
              <Select value={locationId} onValueChange={(v) => setPickedLocationId(v as string)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Location">{(value: string) => locations.find((l) => l.id === value)?.name ?? "Location"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {locations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name} · {row?.byLocation.find((b) => b.locationId === l.id)?.qty ?? 0} here
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {mode === "adjust" ? (
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant={direction === "add" ? "default" : "outline"} onClick={() => setDirection("add")}>
                Add stock
              </Button>
              <Button type="button" variant={direction === "remove" ? "default" : "outline"} onClick={() => setDirection("remove")}>
                Remove stock
              </Button>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="stock-change-qty">Quantity</Label>
            <Input id="stock-change-qty" type="number" inputMode="numeric" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
            {resultingStock !== null ? (
              <p className={goesNegative ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                On hand here after: {resultingStock}
                {goesNegative ? " — can't go below zero" : ""}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="stock-change-reason">Reason (required)</Label>
            <Textarea
              id="stock-change-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={mode === "adjust" ? "e.g. Monthly stock count found 2 extra" : "e.g. Torn seam, dye bleed, stain"}
            />
          </div>

          {mode === "write-off" && row?.weightedAvgCost && qtyValid ? (
            <p className="rounded-md bg-muted px-3 py-2 text-sm">
              Posts an expense of{" "}
              <span className="font-semibold">{formatBDT(fromPaisa(toPaisa(row.weightedAvgCost) * qtyNumber))}</span> ({qtyNumber} ×{" "}
              {formatBDT(row.weightedAvgCost)} at cost) under “Damage / write-off”.
            </p>
          ) : null}

          {mode === "adjust" && row?.weightedAvgCost && qtyValid && Number(row.weightedAvgCost) > 0 ? (
            <p className="rounded-md bg-muted px-3 py-2 text-sm">
              {direction === "remove" ? "Posts an expense of " : "Credits "}
              <span className="font-semibold">{formatBDT(fromPaisa(toPaisa(row.weightedAvgCost) * qtyNumber))}</span> ({qtyNumber} ×{" "}
              {formatBDT(row.weightedAvgCost)} at cost) {direction === "remove" ? "under" : "back to"} “Stock shortage”.
            </p>
          ) : null}

          {error ?<p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button
            onClick={submit}
            variant={mode === "write-off" ? "destructive" : "default"}
            disabled={saving || !qtyValid || goesNegative || !locationId || reason.trim().length < 3}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {mode === "adjust" ? "Save adjustment" : "Write off"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
