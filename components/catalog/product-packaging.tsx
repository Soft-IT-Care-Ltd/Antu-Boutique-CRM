"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { PackagingLinesEditor, type PackagingLineDraft, type PackagingMaterialOption } from "@/components/catalog/packaging-lines-editor";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import type { PackagingLine } from "@/lib/sets/types";

// P3.3 — the packaging each unit of this product uses (a box per saree, a
// hang tag per garment). Taken out of stock when it's packed or sold, and
// inside outfit sets too.
export function ProductPackaging({ productId, canEdit }: { productId: string; canEdit: boolean }) {
  const [materials, setMaterials] = useState<PackagingMaterialOption[] | null>(null);
  const [lines, setLines] = useState<PackagingLineDraft[]>([]);
  const [saved, setSaved] = useState("[]");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    Promise.all([fetchJson<{ materials: PackagingMaterialOption[] }>("/api/catalog/packaging"), fetchJson<{ packaging: PackagingLine[] }>(`/api/catalog/products/${productId}/packaging`)])
      .then(([m, p]) => {
        const current = p.packaging.map((l) => ({ materialVariantId: l.materialVariantId, qty: l.qty }));
        setMaterials(m.materials);
        setLines(current);
        setSaved(JSON.stringify(current));
      })
      .catch((err) => setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not load packaging." }));
  }, [productId]);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      await fetchJson(`/api/catalog/products/${productId}/packaging`, { method: "PUT", body: JSON.stringify({ lines }) });
      setSaved(JSON.stringify(lines));
      setMessage({ ok: true, text: "Saved." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Packaging</CardTitle>
        <CardDescription>What each piece goes out with. Taken from stock when it&apos;s packed or sold at the counter, in outfit sets too.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!materials ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <PackagingLinesEditor materials={materials} value={lines} onChange={setLines} disabled={!canEdit} unit="per piece" />
        )}
        {canEdit && materials && JSON.stringify(lines) !== saved ? (
          <Button size="sm" className="self-start" onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            Save packaging
          </Button>
        ) : null}
        {message ? <p className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p> : null}
      </CardContent>
    </Card>
  );
}
