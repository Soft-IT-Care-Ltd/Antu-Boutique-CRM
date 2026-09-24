"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Loader2, Package, Plus } from "lucide-react";

import { PackagingLinesEditor, type PackagingLineDraft } from "@/components/catalog/packaging-lines-editor";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import { formatBDT } from "@/lib/money";
import type { PackagingMaterial } from "@/lib/packaging/service";
import type { PackagingLine } from "@/lib/sets/types";

type Scope = "ONLINE_PARCEL" | "POS_SALE";
type Data = { materials: PackagingMaterial[]; defaults: Record<Scope, PackagingLine[]> };

const SCOPES: { scope: Scope; title: string; description: string; unit: string }[] = [
  { scope: "ONLINE_PARCEL", title: "Every online parcel", description: "Used once per order packed for the courier, whatever is inside (e.g. a mailer bag).", unit: "per parcel" },
  { scope: "POS_SALE", title: "Every showroom sale", description: "Used once per counter sale (e.g. a shopping bag and tissue).", unit: "per sale" },
];

// P3.3 — packaging materials (Antu's branded bags, boxes, tissue and tags):
// products of type "Packaging material", stocked and costed but never sold.
// Packing an order or a counter sale takes them out of stock and posts
// their cost under "Packaging" once per order.
export function PackagingManager({ canManage, canCreateProduct, hasCostAccess }: { canManage: boolean; canCreateProduct: boolean; hasCostAccess: boolean }) {
  const [data, setData] = useState<Data | null>(null);
  const [drafts, setDrafts] = useState<Record<Scope, PackagingLineDraft[]> | null>(null);
  const [saving, setSaving] = useState<Scope | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetchJson<Data>("/api/catalog/packaging")
      .then((d) => {
        setData(d);
        setDrafts({
          ONLINE_PARCEL: d.defaults.ONLINE_PARCEL.map((l) => ({ materialVariantId: l.materialVariantId, qty: l.qty })),
          POS_SALE: d.defaults.POS_SALE.map((l) => ({ materialVariantId: l.materialVariantId, qty: l.qty })),
        });
      })
      .catch((err) => setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not load packaging." }));
  }, []);

  async function save(scope: Scope) {
    if (!drafts) return;
    setSaving(scope);
    setMessage(null);
    try {
      await fetchJson("/api/catalog/packaging", { method: "PUT", body: JSON.stringify({ scope, lines: drafts[scope] }) });
      setMessage({ ok: true, text: "Saved — it applies to orders packed and sales made from now on." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not save." });
    } finally {
      setSaving(null);
    }
  }

  if (!data || !drafts) {
    return message ? <p className="text-sm text-destructive">{message.text}</p> : <Skeleton className="h-48 w-full" />;
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base">Packaging materials</CardTitle>
            <CardDescription>Stocked through purchases like any product; never sold. Each product and set says which it uses.</CardDescription>
          </div>
          {canCreateProduct ? (
            <Button size="sm" render={<Link href="/catalog/products/new?kind=COMPONENT_ONLY" />} nativeButton={false}>
              <Plus />
              New material
            </Button>
          ) : null}
        </CardHeader>
        <CardContent>
          {data.materials.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
              <Package className="size-8" />
              No packaging materials yet — add your branded bags, boxes, tissue and tags.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Material</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">In stock</TableHead>
                    {hasCostAccess ? <TableHead className="text-right">Cost each</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.materials.map((m) => (
                    <TableRow key={m.variantId}>
                      <TableCell>
                        <Link href={`/catalog/products/${m.productId}`} className="hover:underline">
                          {m.label}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{m.sku}</TableCell>
                      <TableCell className={`text-right tabular-nums ${m.available <= 0 ? "text-destructive" : ""}`}>{m.available}</TableCell>
                      {hasCostAccess ? <TableCell className="text-right tabular-nums">{m.weightedAvgCost ? formatBDT(m.weightedAvgCost) : "—"}</TableCell> : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {SCOPES.map((s) => (
          <Card key={s.scope}>
            <CardHeader>
              <CardTitle className="text-base">{s.title}</CardTitle>
              <CardDescription>{s.description}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <PackagingLinesEditor
                materials={data.materials.map((m) => ({ variantId: m.variantId, label: m.label, sku: m.sku, available: m.available }))}
                value={drafts[s.scope]}
                onChange={(lines) => setDrafts({ ...drafts, [s.scope]: lines })}
                disabled={!canManage}
                unit={s.unit}
              />
              {canManage ? (
                <Button size="sm" className="self-start" onClick={() => void save(s.scope)} disabled={saving !== null}>
                  {saving === s.scope ? <Loader2 className="animate-spin" /> : null}
                  Save
                </Button>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
      {message ? <p className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p> : null}
    </div>
  );
}
