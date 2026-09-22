"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import type { Category, ProductDetail } from "@/lib/catalog/types";

type ProductFormValues = {
  name: string;
  code: string;
  categoryId: string | null;
  brand: string;
  description: string;
  fabric: string;
  basePrice: string;
  tags: string[];
  isActive: boolean;
};

function toFormValues(product?: ProductDetail): ProductFormValues {
  if (!product) {
    return { name: "", code: "", categoryId: null, brand: "", description: "", fabric: "", basePrice: "", tags: [], isActive: true };
  }
  return {
    name: product.name,
    code: product.code,
    categoryId: product.categoryId,
    brand: product.brand ?? "",
    description: product.description ?? "",
    fabric: product.fabric ?? "",
    basePrice: product.basePrice,
    tags: product.tags,
    isActive: product.isActive,
  };
}

export function ProductForm({
  categories,
  product,
  onSaved,
}: {
  categories: Category[];
  product?: ProductDetail;
  onSaved?: (product: ProductDetail) => void;
}) {
  const router = useRouter();
  const isEdit = Boolean(product);
  const [values, setValues] = useState<ProductFormValues>(toFormValues(product));
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addTag() {
    const tag = tagInput.trim();
    if (tag && !values.tags.includes(tag)) {
      setValues({ ...values, tags: [...values.tags, tag] });
    }
    setTagInput("");
  }

  function removeTag(tag: string) {
    setValues({ ...values, tags: values.tags.filter((t) => t !== tag) });
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const payload = {
      name: values.name,
      ...(isEdit ? { code: values.code } : values.code ? { code: values.code } : {}),
      categoryId: values.categoryId,
      brand: values.brand || null,
      description: values.description || null,
      fabric: values.fabric || null,
      basePrice: values.basePrice,
      tags: values.tags,
      isActive: values.isActive,
    };

    try {
      if (isEdit && product) {
        const { product: updated } = await fetchJson<{ product: ProductDetail }>(`/api/catalog/products/${product.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        onSaved?.({ ...product, ...updated });
      } else {
        const { product: created } = await fetchJson<{ product: ProductDetail }>("/api/catalog/products", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        router.push(`/catalog/products/${created.id}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save product.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isEdit ? "Edit product" : "New product"}</CardTitle>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="product-name">Name</Label>
              <Input id="product-name" value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="product-code">
                Code {!isEdit ? <span className="text-muted-foreground">(auto if left blank)</span> : null}
              </Label>
              <Input
                id="product-code"
                value={values.code}
                onChange={(e) => setValues({ ...values, code: e.target.value.toUpperCase() })}
                placeholder="e.g. KURTI12"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Category</Label>
              <Select
                value={values.categoryId ?? "none"}
                onValueChange={(v) => setValues({ ...values, categoryId: v === "none" ? null : (v as string) })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Uncategorised" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Uncategorised</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.parentId ? `${categories.find((p) => p.id === c.parentId)?.name ?? ""} / ${c.name}` : c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="product-brand">Brand / house</Label>
              <Input id="product-brand" value={values.brand} onChange={(e) => setValues({ ...values, brand: e.target.value })} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="product-fabric">Fabric</Label>
              <Input id="product-fabric" value={values.fabric} onChange={(e) => setValues({ ...values, fabric: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="product-price">Base selling price (৳)</Label>
              <Input
                id="product-price"
                type="number"
                min={0}
                step="0.01"
                value={values.basePrice}
                onChange={(e) => setValues({ ...values, basePrice: e.target.value })}
                required
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="product-description">Description</Label>
            <Textarea
              id="product-description"
              value={values.description}
              onChange={(e) => setValues({ ...values, description: e.target.value })}
              rows={3}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="product-tags">Tags</Label>
            <div className="flex gap-2">
              <Input
                id="product-tags"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                placeholder="Type a tag and press Enter"
              />
              <Button type="button" variant="outline" onClick={addTag}>
                Add
              </Button>
            </div>
            {values.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {values.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="gap-1">
                    {tag}
                    <button type="button" onClick={() => removeTag(tag)} className="ml-0.5">
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="product-active">Active</Label>
              <p className="text-xs text-muted-foreground">Inactive products are hidden from order/POS search.</p>
            </div>
            <Switch id="product-active" checked={values.isActive} onCheckedChange={(checked) => setValues({ ...values, isActive: checked })} />
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button type="submit" disabled={saving || !values.name.trim() || !values.basePrice}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {isEdit ? "Save changes" : "Create product"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
