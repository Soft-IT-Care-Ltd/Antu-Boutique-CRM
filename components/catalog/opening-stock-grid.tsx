"use client";

import { useEffect, useState } from "react";
import { Loader2, PackagePlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import type { LocationOption } from "@/lib/locations/constants";
import { formatBDT } from "@/lib/money";

type Candidate = {
  variantId: string;
  sku: string;
  sizeName: string;
  colorName: string;
  colorHex: string;
  weightedAvgCost: string;
};

const num = (v: string | undefined) => (v === undefined || v.trim() === "" ? 0 : Number(v));

/**
 * CORRECTIONS.md item 4 — the stock-in grid: one row per size/colour that
 * has never held stock, one column per location, plus a unit cost per row.
 * Saving posts opening-stock ledger rows per location (never a typed stock
 * field) and the cost becomes the variant's average cost. Once a size/colour
 * has stock history it leaves the grid: new stock comes in by purchase.
 */
export function OpeningStockGrid({ productId, variantCount, onSaved }: { productId: string; variantCount: number; onSaved: () => void }) {
  const [data, setData] = useState<{
    candidates: Candidate[];
    locations: LocationOption[];
  } | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [cost, setCost] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // Re-read whenever sizes/colours are generated.
  useEffect(() => {
    fetchJson<{ candidates: Candidate[]; locations: LocationOption[] }>(`/api/catalog/products/${productId}/opening-stock`)
      .then(setData)
      .catch(() => setData({ candidates: [], locations: [] }));
  }, [productId, variantCount, reload]);

  // Only sizes/colours with no stock history are listed; none left, no card.
  if (!data || (data.candidates.length === 0 && !notice)) return null;
  const { candidates, locations } = data;
  const cell = (variantId: string, locationId: string) => `${variantId}:${locationId}`;
  const rowUnits = (variantId: string) => locations.reduce((sum, l) => sum + Math.max(0, Math.floor(num(qty[cell(variantId, l.id)]))), 0);
  const rows = candidates.map((c) => ({
    c,
    units: rowUnits(c.variantId),
    cost: cost[c.variantId] ?? (Number(c.weightedAvgCost) > 0 ? c.weightedAvgCost : ""),
  }));
  const filled = rows.filter((r) => r.units > 0);
  const badQty = Object.values(qty).some((v) => v.trim() !== "" && (!Number.isInteger(Number(v)) || Number(v) < 0));
  const missingCost = filled.some((r) => r.cost.trim() === "" || !(Number(r.cost) >= 0));
  const totalUnits = filled.reduce((s, r) => s + r.units, 0);
  const totalValuePaisa = filled.reduce((s, r) => s + r.units * toPaisa(Number(r.cost) || 0), 0);

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await fetchJson<{ units: number; variants: number }>(`/api/catalog/products/${productId}/opening-stock`, {
        method: "POST",
        body: JSON.stringify({
          lines: filled.map((r) => ({
            variantId: r.c.variantId,
            unitCost: Number(r.cost),
            quantities: locations
              .map((l) => ({
                locationId: l.id,
                qty: Math.max(0, Math.floor(num(qty[cell(r.c.variantId, l.id)]))),
              }))
              .filter((q) => q.qty > 0),
          })),
        }),
      });
      setQty({});
      setCost({});
      setNotice(`Opening stock saved: ${result.units} unit(s) across ${result.variants} size/colour(s).`);
      setReload((n) => n + 1);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the opening stock.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Opening stock by location</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {candidates.length === 0 ? (
          <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <PackagePlus className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                How many of each size/colour are at each location today, and what one cost. This is entered once, as opening stock; after that, stock comes in through a purchase.
              </p>
            </div>
            {locations.length === 0 ? (
              <p className="text-sm text-destructive">You aren&apos;t assigned to any stock location — ask an Admin to assign you in Settings → Locations.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-36">Size / colour</TableHead>
                      {locations.map((l) => (
                        <TableHead key={l.id} className="min-w-24 text-right">
                          {l.name}
                        </TableHead>
                      ))}
                      <TableHead className="min-w-28 text-right">Unit cost (৳)</TableHead>
                      <TableHead className="text-right">Units</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map(({ c, units, cost: rowCost }) => (
                      <TableRow key={c.variantId}>
                        <TableCell>
                          <span className="flex items-center gap-1.5">
                            <span className="size-3 shrink-0 rounded-full border" style={{ backgroundColor: c.colorHex }} />
                            <b>{c.sizeName}</b> · {c.colorName}
                          </span>
                          <span className="font-mono text-xs text-muted-foreground">{c.sku}</span>
                        </TableCell>
                        {locations.map((l) => (
                          <TableCell key={l.id} className="text-right">
                            <Input
                              className="ml-auto h-9 w-20 text-right tabular-nums"
                              inputMode="numeric"
                              placeholder="0"
                              aria-label={`${c.sku} at ${l.name}`}
                              value={qty[cell(c.variantId, l.id)] ?? ""}
                              onChange={(e) =>
                                setQty((prev) => ({
                                  ...prev,
                                  [cell(c.variantId, l.id)]: e.target.value.replace(/[^\d]/g, ""),
                                }))
                              }
                            />
                          </TableCell>
                        ))}
                        <TableCell className="text-right">
                          <Input
                            className="ml-auto h-9 w-24 text-right tabular-nums"
                            inputMode="decimal"
                            placeholder="0.00"
                            aria-label={`Unit cost of ${c.sku}`}
                            value={rowCost}
                            onChange={(e) =>
                              setCost((prev) => ({
                                ...prev,
                                [c.variantId]: e.target.value,
                              }))
                            }
                          />
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">{units}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {missingCost ? <p className="text-sm text-destructive">Every row with stock needs a unit cost — it becomes the average cost.</p> : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            {notice ? <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p> : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                {totalUnits} unit(s)
                {totalUnits > 0 ? ` · ${formatBDT(fromPaisa(totalValuePaisa))} at cost` : ""}
              </p>
              <Button onClick={() => void save()} disabled={saving || totalUnits === 0 || missingCost || badQty || locations.length === 0}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                Save opening stock
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
