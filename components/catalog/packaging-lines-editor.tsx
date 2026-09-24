"use client";

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type PackagingMaterialOption = { variantId: string; label: string; sku: string; available: number };
export type PackagingLineDraft = { materialVariantId: string; qty: number };

// P3.3 — which packaging materials (bags, boxes, tissue, tags) something
// uses, and how many. Shared by the product page, the set editor and the
// per-parcel / per-sale defaults.
export function PackagingLinesEditor({
  materials,
  value,
  onChange,
  disabled,
  unit,
}: {
  materials: PackagingMaterialOption[];
  value: PackagingLineDraft[];
  onChange: (value: PackagingLineDraft[]) => void;
  disabled?: boolean;
  /** "per unit", "per set", "per parcel"… */
  unit: string;
}) {
  const unused = materials.filter((m) => !value.some((v) => v.materialVariantId === m.variantId));
  const labelOf = (id: string) => materials.find((m) => m.variantId === id)?.label ?? "Material no longer in the catalog";

  if (materials.length === 0) {
    return <p className="text-sm text-muted-foreground">No packaging materials yet — add them as products of type &quot;Packaging material&quot; first.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {value.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : null}
      {value.map((line, index) => (
        <div key={line.materialVariantId} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">{labelOf(line.materialVariantId)}</span>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={99}
            className="h-9 w-16"
            aria-label="How many"
            disabled={disabled}
            value={line.qty}
            onChange={(e) => onChange(value.map((v, i) => (i === index ? { ...v, qty: Math.max(1, Math.min(99, Number(e.target.value) || 1)) } : v)))}
          />
          <span className="w-16 text-xs text-muted-foreground">{unit}</span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove" disabled={disabled} onClick={() => onChange(value.filter((_, i) => i !== index))}>
            <Trash2 />
          </Button>
        </div>
      ))}
      {unused.length > 0 && !disabled ? (
        <Select value="" onValueChange={(id) => id && onChange([...value, { materialVariantId: id as string, qty: 1 }])}>
          <SelectTrigger className="h-9 w-full sm:w-72">
            <SelectValue placeholder="Add packaging">
              {() => (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Plus className="size-3.5" /> Add packaging
                </span>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {unused.map((m) => (
              <SelectItem key={m.variantId} value={m.variantId}>
                {m.label} · {m.available} in stock
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}
