"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Sparkles, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import type { ColorMaster, ProductVariant, SizeMaster } from "@/lib/catalog/types";

type EditableFields = {
  sku?: string;
  priceOverride?: string;
  lowStockThreshold?: string;
  weightGrams?: string;
  isActive?: boolean;
};

export function VariantMatrix({
  productId,
  basePrice,
  initialVariants,
  sizes,
  colors,
  canGenerate,
  canEdit,
  hasCostView,
  lowStockDefault,
  onVariantsChange,
  onProductCodeChange,
}: {
  productId: string;
  basePrice: string;
  initialVariants: ProductVariant[];
  sizes: SizeMaster[];
  colors: ColorMaster[];
  canGenerate: boolean;
  canEdit: boolean;
  hasCostView: boolean;
  /** Settings → low-stock default, for variants without their own threshold. */
  lowStockDefault: number;
  onVariantsChange?: (variants: ProductVariant[]) => void;
  onProductCodeChange?: (code: string) => void;
}) {
  const [variants, setVariants] = useState(initialVariants);

  // Keeps the product header's "Variants" / "Total available" tallies (owned
  // by the parent) in sync after a generate/save/delete here, without lifting
  // the whole matrix's edit-in-progress state up.
  useEffect(() => {
    onVariantsChange?.(variants);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variants]);
  const [edits, setEdits] = useState<Record<string, EditableFields>>({});
  const [selectedSizes, setSelectedSizes] = useState<Set<string>>(new Set());
  const [selectedColors, setSelectedColors] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when generating moved the product to a new code to keep SKUs unique.
  const [notice, setNotice] = useState<string | null>(null);

  const dirtyCount = Object.keys(edits).length;

  function fieldValue(variant: ProductVariant, field: keyof EditableFields) {
    const edit = edits[variant.id];
    if (edit && field in edit) return edit[field];
    if (field === "sku") return variant.sku;
    if (field === "priceOverride") return variant.priceOverride ?? "";
    if (field === "lowStockThreshold") return variant.lowStockThreshold?.toString() ?? "";
    if (field === "weightGrams") return variant.weightGrams?.toString() ?? "";
    if (field === "isActive") return variant.isActive;
    return undefined;
  }

  function setField(variant: ProductVariant, field: keyof EditableFields, value: string | boolean) {
    setEdits((prev) => ({ ...prev, [variant.id]: { ...prev[variant.id], [field]: value } }));
  }

  function toggleSet(set: Set<string>, id: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  }

  async function handleGenerate() {
    if (selectedSizes.size === 0 || selectedColors.size === 0) {
      setError("Pick at least one size and one colour.");
      return;
    }
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      const data = await fetchJson<{ variants: ProductVariant[]; productCode: string; notice: string | null }>(
        `/api/catalog/products/${productId}/variants/generate`,
        { method: "POST", body: JSON.stringify({ sizeIds: Array.from(selectedSizes), colorIds: Array.from(selectedColors) }) },
      );
      setVariants(data.variants);
      setNotice(data.notice);
      onProductCodeChange?.(data.productCode);
      setSelectedSizes(new Set());
      setSelectedColors(new Set());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not generate variants.");
    } finally {
      setGenerating(false);
    }
  }

  async function handleSave() {
    if (dirtyCount === 0) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        edits: Object.entries(edits).map(([variantId, fields]) => ({
          variantId,
          ...(fields.sku !== undefined ? { sku: fields.sku } : {}),
          ...(fields.priceOverride !== undefined ? { priceOverride: fields.priceOverride === "" ? null : Number(fields.priceOverride) } : {}),
          ...(fields.lowStockThreshold !== undefined
            ? { lowStockThreshold: fields.lowStockThreshold === "" ? null : Number(fields.lowStockThreshold) }
            : {}),
          ...(fields.weightGrams !== undefined ? { weightGrams: fields.weightGrams === "" ? null : Number(fields.weightGrams) } : {}),
          ...(fields.isActive !== undefined ? { isActive: fields.isActive } : {}),
        })),
      };
      const data = await fetchJson<{ variants: ProductVariant[] }>(`/api/catalog/products/${productId}/variants`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setVariants(data.variants);
      setEdits({});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save variant changes.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(variantId: string) {
    setError(null);
    try {
      await fetchJson(`/api/catalog/products/${productId}/variants/${variantId}`, { method: "DELETE" });
      setVariants((prev) => prev.filter((v) => v.id !== variantId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete variant.");
    }
  }

  const existingPairs = useMemo(() => new Set(variants.map((v) => `${v.sizeId}:${v.colorId}`)), [variants]);
  const willGenerateCount = useMemo(() => {
    let count = 0;
    for (const s of selectedSizes) for (const c of selectedColors) if (!existingPairs.has(`${s}:${c}`)) count += 1;
    return count;
  }, [selectedSizes, selectedColors, existingPairs]);

  return (
    <div className="flex flex-col gap-4">
      {canGenerate ? (
        <div className="rounded-lg border p-3">
          <div className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <Sparkles className="size-4" />
            Generate variants
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Sizes</Label>
              <div className="flex flex-wrap gap-3">
                {sizes.map((size) => (
                  <label key={size.id} className="flex items-center gap-1.5 text-sm">
                    <Checkbox checked={selectedSizes.has(size.id)} onCheckedChange={() => toggleSet(selectedSizes, size.id, setSelectedSizes)} />
                    {size.name}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Colours</Label>
              <div className="flex flex-wrap gap-3">
                {colors.map((color) => (
                  <label key={color.id} className="flex items-center gap-1.5 text-sm">
                    <Checkbox checked={selectedColors.has(color.id)} onCheckedChange={() => toggleSet(selectedColors, color.id, setSelectedColors)} />
                    <span className="size-3 rounded-full border border-border" style={{ backgroundColor: color.hexCode }} />
                    {color.name}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={handleGenerate} disabled={generating || selectedSizes.size === 0 || selectedColors.size === 0}>
              {generating ? <Loader2 className="size-4 animate-spin" /> : null}
              Generate {willGenerateCount > 0 ? `(${willGenerateCount} new)` : ""}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {notice ? (
        <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {notice}
        </p>
      ) : null}

      {variants.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No variants yet. {canGenerate ? "Pick sizes and colours above to generate them." : ""}
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Size</TableHead>
                <TableHead>Colour</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Low stock at</TableHead>
                <TableHead title="Parcel weight per unit, for courier cost estimates">Weight (g)</TableHead>
                <TableHead>Stock</TableHead>
                <TableHead>Reserved</TableHead>
                <TableHead>Available</TableHead>
                {hasCostView ? <TableHead>Avg. cost</TableHead> : null}
                <TableHead>Active</TableHead>
                {canEdit ? <TableHead /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {variants.map((variant) => {
                const available = variant.stockQty - variant.reservedQty;
                const threshold = variant.lowStockThreshold ?? lowStockDefault;
                const isLow = available <= threshold;
                return (
                  <TableRow key={variant.id}>
                    <TableCell>{variant.size.name}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <span className="size-3 shrink-0 rounded-full border border-border" style={{ backgroundColor: variant.color.hexCode }} />
                        {variant.color.name}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Input
                        value={fieldValue(variant, "sku") as string}
                        disabled={!canEdit || variant.skuLocked}
                        maxLength={9}
                        title={variant.skuLocked ? "Locked — a price tag has been printed for this SKU" : "Up to 9 capital letters and digits"}
                        onChange={(e) => setField(variant, "sku", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                        className="h-7 w-28 font-mono text-xs"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        placeholder={formatBDT(basePrice)}
                        value={fieldValue(variant, "priceOverride") as string}
                        disabled={!canEdit}
                        onChange={(e) => setField(variant, "priceOverride", e.target.value)}
                        className="h-7 w-24"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={0}
                        placeholder={String(lowStockDefault)}
                        value={fieldValue(variant, "lowStockThreshold") as string}
                        disabled={!canEdit}
                        onChange={(e) => setField(variant, "lowStockThreshold", e.target.value)}
                        className="h-7 w-20"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={1}
                        placeholder="—"
                        value={fieldValue(variant, "weightGrams") as string}
                        disabled={!canEdit}
                        onChange={(e) => setField(variant, "weightGrams", e.target.value)}
                        className="h-7 w-20"
                      />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{variant.stockQty}</TableCell>
                    <TableCell className="text-muted-foreground">{variant.reservedQty}</TableCell>
                    <TableCell>
                      <Badge variant={available <= 0 ? "destructive" : isLow ? "outline" : "secondary"}>{available}</Badge>
                    </TableCell>
                    {hasCostView ? <TableCell className="text-muted-foreground">{formatBDT(variant.weightedAvgCost ?? "0")}</TableCell> : null}
                    <TableCell>
                      <Switch
                        checked={fieldValue(variant, "isActive") as boolean}
                        disabled={!canEdit}
                        onCheckedChange={(checked) => setField(variant, "isActive", checked)}
                        size="sm"
                      />
                    </TableCell>
                    {canEdit ? (
                      <TableCell>
                        <AlertDialog>
                          <AlertDialogTrigger render={<Button variant="ghost" size="icon-sm" disabled={variant.stockQty !== 0 || variant.reservedQty !== 0} />}>
                            <Trash2 />
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete {variant.sku}?</AlertDialogTitle>
                              <AlertDialogDescription>This can&apos;t be undone.</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => handleDelete(variant.id)}>Delete</AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {canEdit ? (
            <div className="flex justify-end">
              <Button size="sm" onClick={handleSave} disabled={saving || dirtyCount === 0}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                Save changes {dirtyCount > 0 ? `(${dirtyCount})` : ""}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
