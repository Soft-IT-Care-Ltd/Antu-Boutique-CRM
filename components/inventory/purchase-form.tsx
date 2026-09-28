"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Loader2, PackagePlus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { OrderItemPicker, type PickedVariant } from "@/components/orders/order-item-picker";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import { ALLOCATION_METHOD_LABELS, todayInDhaka } from "@/lib/inventory/constants";
import { costPurchase, fromPaisa, toPaisa, type AllocationMethod } from "@/lib/inventory/costing";
import { newLocalId } from "@/lib/browser/local-id";
import type { LocationOption } from "@/lib/locations/constants";
import { formatBDT } from "@/lib/money";

// C3 (CORRECTIONS.md item 4): each line is received at a location (default:
// the packing hub). The same size/colour may come in at two locations —
// two lines — but only once per location.
type Line = PickedVariant & { key: string; locationId: string; qty: string; unitCost: string };

const num = (value: string) => (value.trim() === "" ? 0 : Number(value));

/**
 * PRD §4.3 purchase entry. The preview here uses the same costPurchase()
 * the server runs, so the landed costs shown are exactly what gets saved —
 * but the server recomputes everything; nothing costed here is trusted.
 */
export function PurchaseForm({ suppliers, locations }: { suppliers: { id: string; name: string }[]; locations: LocationOption[] }) {
  const router = useRouter();
  const defaultLocationId = (locations.find((l) => l.isPackingHub) ?? locations[0])?.id ?? "";
  const [supplierId, setSupplierId] = useState<string>("");
  const [purchaseDate, setPurchaseDate] = useState(todayInDhaka());
  const [invoiceNo, setInvoiceNo] = useState("");
  const [allocationMethod, setAllocationMethod] = useState<AllocationMethod>("BY_VALUE");
  const [transportCost, setTransportCost] = useState("");
  const [otherCost, setOtherCost] = useState("");
  const [amountPaid, setAmountPaid] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lineKeys = lines.map((l) => `${l.variantId}@${l.locationId}`);
  const duplicateLocation = new Set(lineKeys).size !== lineKeys.length;
  const linesValid = lines.length > 0 && !duplicateLocation && lines.every((l) => l.locationId && Number.isInteger(num(l.qty)) && num(l.qty) > 0 && num(l.unitCost) >= 0);
  const costed = useMemo(
    () =>
      costPurchase(
        lines.map((l) => ({ qty: Math.max(0, Math.floor(num(l.qty))), unitCost: Math.max(0, num(l.unitCost)) || 0 })),
        Math.max(0, num(transportCost)) || 0,
        Math.max(0, num(otherCost)) || 0,
        allocationMethod,
      ),
    [lines, transportCost, otherCost, allocationMethod],
  );
  const paidPaisa = toPaisa(Math.max(0, num(amountPaid)) || 0);
  const overpaid = paidPaisa > costed.totalCostPaisa;

  function addLine(variant: PickedVariant) {
    // Added again: the next location it isn't on yet (a split delivery).
    const used = new Set(lines.filter((l) => l.variantId === variant.variantId).map((l) => l.locationId));
    const locationId = [defaultLocationId, ...locations.map((l) => l.id)].find((id) => id && !used.has(id));
    if (!locationId) {
      setError(`${variant.sku} is already on this purchase for every location — change its quantities instead.`);
      return;
    }
    setError(null);
    const earlier = lines.find((l) => l.variantId === variant.variantId);
    setLines((prev) => [
      ...prev,
      { ...variant, key: newLocalId(), locationId, qty: "1", unitCost: earlier?.unitCost ?? (variant.weightedAvgCost && Number(variant.weightedAvgCost) > 0 ? variant.weightedAvgCost : "") },
    ]);
  }

  function updateLine(key: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const { purchase } = await fetchJson<{ purchase: { id: string } }>("/api/inventory/purchases", {
        method: "POST",
        body: JSON.stringify({
          supplierId,
          purchaseDate,
          invoiceNo: invoiceNo || null,
          allocationMethod,
          transportCost: num(transportCost),
          otherCost: num(otherCost),
          amountPaid: num(amountPaid),
          note: note || null,
          items: lines.map((l) => ({ variantId: l.variantId, locationId: l.locationId, qty: num(l.qty), unitCost: num(l.unitCost) })),
        }),
      });
      router.push(`/inventory/purchases/${purchase.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the purchase.");
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Supplier & invoice</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5 sm:col-span-3 md:col-span-1">
            <Label>Supplier</Label>
            {suppliers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No active suppliers.{" "}
                <Link href="/inventory/suppliers" className="underline">
                  Add one first
                </Link>
                .
              </p>
            ) : (
              <Select value={supplierId} onValueChange={(v) => setSupplierId(v as string)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick a supplier">{(value: string) => suppliers.find((s) => s.id === value)?.name ?? "Pick a supplier"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="purchase-date">Purchase date</Label>
            <Input id="purchase-date" type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="purchase-invoice">Supplier invoice no.</Label>
            <Input id="purchase-invoice" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="Optional" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Items</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <OrderItemPicker onPick={addLine} />

          {lines.length === 0 ? (
            <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
              <PackagePlus className="size-6" />
              Search above to add the sizes and colours you bought.
            </div>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {lines.map((line, i) => {
                const c = costed.lines[i];
                return (
                  <li key={line.key} className="grid gap-2 p-3 sm:grid-cols-[1fr_11rem_6rem_8rem_9rem_auto] sm:items-end">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{line.productName}</div>
                      <div className="flex items-center gap-1.5 text-sm">
                        <span className="size-3 shrink-0 rounded-full border border-border" style={{ backgroundColor: line.colorHex }} />
                        <span className="font-semibold">
                          {line.sizeName} / {line.colorName}
                        </span>
                        <span className="truncate font-mono text-xs text-muted-foreground">{line.sku}</span>
                      </div>
                      {line.weightedAvgCost ? <div className="text-xs text-muted-foreground">Current avg cost {formatBDT(line.weightedAvgCost)}</div> : null}
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs">Received at</Label>
                      <Select value={line.locationId} onValueChange={(v) => updateLine(line.key, { locationId: v as string })}>
                        <SelectTrigger className="w-full" aria-label={`Location for ${line.sku}`}>
                          <SelectValue placeholder="Location">{(value: string) => locations.find((l) => l.id === value)?.name ?? "Location"}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {locations.map((l) => (
                            <SelectItem key={l.id} value={l.id}>
                              {l.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs" htmlFor={`qty-${line.key}`}>
                        Qty
                      </Label>
                      <Input
                        id={`qty-${line.key}`}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        step={1}
                        value={line.qty}
                        onChange={(e) => updateLine(line.key, { qty: e.target.value })}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs" htmlFor={`cost-${line.key}`}>
                        Unit cost (৳)
                      </Label>
                      <Input
                        id={`cost-${line.key}`}
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.01"
                        value={line.unitCost}
                        onChange={(e) => updateLine(line.key, { unitCost: e.target.value })}
                      />
                    </div>
                    <div className="text-sm sm:text-right">
                      <div className="text-xs text-muted-foreground">Landed / unit</div>
                      <div className="font-semibold tabular-nums">{formatBDT(fromPaisa(c?.landedUnitCostPaisa ?? 0))}</div>
                      {c && c.allocatedPaisa > 0 ? <div className="text-xs text-muted-foreground">+{formatBDT(fromPaisa(c.allocatedPaisa))} share</div> : null}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="justify-self-end"
                      aria-label={`Remove ${line.sku}`}
                      onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                    >
                      <Trash2 />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {duplicateLocation ? <p className="text-sm text-destructive">A size/colour is on two lines for the same location — combine them, or pick another location.</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Costs & payment</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="purchase-transport">Transport cost (৳)</Label>
            <Input id="purchase-transport" type="number" inputMode="decimal" min={0} step="0.01" value={transportCost} onChange={(e) => setTransportCost(e.target.value)} placeholder="0" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="purchase-other">Other cost (৳)</Label>
            <Input id="purchase-other" type="number" inputMode="decimal" min={0} step="0.01" value={otherCost} onChange={(e) => setOtherCost(e.target.value)} placeholder="0" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Spread extra cost</Label>
            <Select value={allocationMethod} onValueChange={(v) => setAllocationMethod(v as AllocationMethod)}>
              <SelectTrigger className="w-full">
                <SelectValue>{(value: AllocationMethod) => ALLOCATION_METHOD_LABELS[value]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ALLOCATION_METHOD_LABELS) as AllocationMethod[]).map((m) => (
                  <SelectItem key={m} value={m}>
                    {ALLOCATION_METHOD_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="purchase-paid">Amount paid now (৳)</Label>
            <Input id="purchase-paid" type="number" inputMode="decimal" min={0} step="0.01" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} placeholder="0" />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-4">
            <Label htmlFor="purchase-note">Note</Label>
            <Textarea id="purchase-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <dt className="text-muted-foreground">Items</dt>
            <dd className="text-right tabular-nums sm:text-left">{formatBDT(fromPaisa(costed.itemsSubtotalPaisa))}</dd>
            <dt className="text-muted-foreground">Transport + other</dt>
            <dd className="text-right tabular-nums sm:text-left">{formatBDT(fromPaisa(costed.extraCostPaisa))}</dd>
            <dt className="font-medium">Total</dt>
            <dd className="text-right font-semibold tabular-nums sm:text-left">{formatBDT(fromPaisa(costed.totalCostPaisa))}</dd>
            <dt className="text-muted-foreground">Due to supplier</dt>
            <dd className={`text-right tabular-nums sm:text-left ${overpaid ? "text-destructive" : ""}`}>{formatBDT(fromPaisa(costed.totalCostPaisa - paidPaisa))}</dd>
          </dl>
          <div className="flex flex-col items-stretch gap-1 sm:items-end">
            {overpaid ? <p className="text-sm text-destructive">Amount paid is more than the total.</p> : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button onClick={submit} disabled={saving || !supplierId || !linesValid || overpaid || !purchaseDate}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              Save purchase & add stock
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
