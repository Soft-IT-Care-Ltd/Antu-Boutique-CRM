"use client";

import { useEffect, useState } from "react";
import { Layers, Loader2, Pencil, Plus, Search, Trash2 } from "lucide-react";

import { PackagingLinesEditor, type PackagingLineDraft, type PackagingMaterialOption } from "@/components/catalog/packaging-lines-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import type { ProductListItem } from "@/lib/catalog/types";
import { formatBDT } from "@/lib/money";
import type { SetAvailabilityRow } from "@/lib/sets/service";
import type { SetDetail, SetListItem } from "@/lib/sets/types";

// PRD §4.2 (P3.3) — outfit sets. A set is a list of PRODUCTS with a
// quantity each; the size and colour of every piece is chosen when it's
// sold, so "Kurti + Dupatta + Plazo" is one set, not one per size. Selling
// prices and stock only, except the set's cost for roles that see cost
// (the API strips it for everyone else).

type Draft = {
  id: string | null;
  name: string;
  description: string;
  price: string;
  isActive: boolean;
  components: { productId: string; name: string; code: string; basePrice: string; qty: number }[];
  packaging: PackagingLineDraft[];
};

const emptyDraft = (): Draft => ({ id: null, name: "", description: "", price: "", isActive: true, components: [], packaging: [] });

export function SetsManager({ canCreate, canEdit, canDelete, hasCostAccess }: { canCreate: boolean; canEdit: boolean; canDelete: boolean; hasCostAccess: boolean }) {
  const [view, setView] = useState<"sets" | "availability">("sets");
  const [q, setQ] = useState("");
  const [sets, setSets] = useState<SetListItem[] | null>(null);
  const [report, setReport] = useState<SetAvailabilityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      const url = view === "sets" ? `/api/catalog/sets${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}` : "/api/catalog/sets/availability";
      fetchJson<{ sets?: SetListItem[]; rows?: SetAvailabilityRow[] }>(url)
        .then((d) => {
          if (!live) return;
          if (view === "sets") setSets(d.sets ?? []);
          else setReport(d.rows ?? []);
          setError(null);
        })
        .catch((err) => live && setError(err instanceof ApiError ? err.message : "Could not load outfit sets."));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [view, q, reloadKey]);

  async function openEdit(id: string) {
    try {
      const { set } = await fetchJson<{ set: SetDetail }>(`/api/catalog/sets/${id}`);
      setDraft({
        id: set.id,
        name: set.name,
        description: set.description ?? "",
        price: set.price,
        isActive: set.isActive,
        components: set.components.map((c) => ({ productId: c.productId, name: c.productName, code: c.productCode, basePrice: c.listPrice, qty: c.qty })),
        packaging: set.packaging.map((p) => ({ materialVariantId: p.materialVariantId, qty: p.qty })),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not open the set.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1.5">
          <Button size="sm" variant={view === "sets" ? "default" : "outline"} onClick={() => setView("sets")}>
            Sets
          </Button>
          <Button size="sm" variant={view === "availability" ? "default" : "outline"} onClick={() => setView("availability")}>
            Availability report
          </Button>
        </div>
        {canCreate ? (
          <Button onClick={() => setDraft(emptyDraft())}>
            <Plus />
            New outfit set
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {view === "sets" ? (
        <>
          <div className="relative sm:max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search sets by name" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {!sets ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : sets.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
              <Layers className="size-8" />
              {q ? `No set matches “${q}”.` : "No outfit sets yet. A set is two or more products sold together at one price — the sizes and colours are picked when it's sold."}
            </div>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {sets.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      {s.name}
                      {!s.isActive ? <Badge variant="outline">Inactive</Badge> : null}
                    </p>
                    <p className="text-sm text-muted-foreground">{s.components.map((c) => `${c.qty > 1 ? `${c.qty} × ` : ""}${c.productName}`).join(" + ")}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right text-sm">
                      <p className="font-semibold tabular-nums">{formatBDT(s.price)}</p>
                      <p className={s.availableSets > 0 ? "text-muted-foreground" : "text-destructive"}>
                        {s.availableSets > 0 ? `up to ${s.availableSets} available` : `out of stock — ${s.limitingProduct ?? ""}`}
                      </p>
                    </div>
                    {canEdit ? (
                      <Button variant="outline" size="sm" onClick={() => void openEdit(s.id)}>
                        <Pencil />
                        Edit
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : !report ? (
        <Skeleton className="h-48 w-full" />
      ) : report.length === 0 ? (
        <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">No outfit sets yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Set</TableHead>
                <TableHead className="text-right">Can sell</TableHead>
                <TableHead>Limited by</TableHead>
                <TableHead>Each piece (best size/colour in stock)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">
                    {r.name}
                    {!r.isActive ? <span className="ml-1 text-xs text-muted-foreground">(inactive)</span> : null}
                  </TableCell>
                  <TableCell className={`text-right tabular-nums ${r.availableSets === 0 ? "text-destructive" : ""}`}>{r.availableSets}</TableCell>
                  <TableCell>{r.limitingProduct ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.components.map((c) => (
                      <div key={c.productName} className={c.productName === r.limitingProduct ? "font-medium text-foreground" : undefined}>
                        {c.qty > 1 ? `${c.qty} × ` : ""}
                        {c.productName}: {c.bestVariant ? `${c.bestVariant} — ${c.bestAvailable} available → ${c.bestSets} set${c.bestSets === 1 ? "" : "s"}` : "no size/colour for sale"}
                      </div>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">
            A set can sell as many times as its scarcest piece allows: for each piece, the best-stocked size/colour divided by how many go in a set. The customer&apos;s own choice may have less.
          </p>
        </div>
      )}

      {draft ? (
        <SetEditor
          draft={draft}
          canDelete={canDelete && draft.id !== null}
          hasCostAccess={hasCostAccess}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            setReloadKey((k) => k + 1);
          }}
        />
      ) : null}
    </div>
  );
}

function SetEditor({ draft: initial, canDelete, hasCostAccess, onClose, onSaved }: { draft: Draft; canDelete: boolean; hasCostAccess: boolean; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<ProductListItem[]>([]);
  const [materials, setMaterials] = useState<PackagingMaterialOption[]>([]);
  const [cost, setCost] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<{ materials: PackagingMaterialOption[] }>("/api/catalog/packaging")
      .then((d) => setMaterials(d.materials))
      .catch(() => setMaterials([]));
    if (initial.id && hasCostAccess) {
      fetchJson<{ set: SetDetail }>(`/api/catalog/sets/${initial.id}`)
        .then((d) => setCost(d.set.cost ?? null))
        .catch(() => setCost(null));
    }
  }, [initial.id, hasCostAccess]);

  useEffect(() => {
    const term = search.trim();
    if (term.length < 2) return;
    const t = setTimeout(() => {
      fetchJson<{ items: ProductListItem[] }>(`/api/catalog/products?q=${encodeURIComponent(term)}&kind=SELLABLE&pageSize=8`)
        .then((d) => setHits(d.items))
        .catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [search]);

  const listValue = draft.components.reduce((sum, c) => sum + Number(c.basePrice) * c.qty, 0);
  const invalid = !draft.name.trim() || draft.price === "" || Number(draft.price) < 0 || draft.components.length < 2;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body = JSON.stringify({
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        price: Number(draft.price),
        isActive: draft.isActive,
        components: draft.components.map((c) => ({ productId: c.productId, qty: c.qty })),
        packaging: draft.packaging,
      });
      if (draft.id) await fetchJson(`/api/catalog/sets/${draft.id}`, { method: "PATCH", body });
      else await fetchJson("/api/catalog/sets", { method: "POST", body });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the set.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!draft.id || !window.confirm(`Move "${draft.name}" to the trash? Orders that sold it keep it.`)) return;
    setSaving(true);
    try {
      await fetchJson(`/api/catalog/sets/${draft.id}`, { method: "DELETE" });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete the set.");
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{draft.id ? "Edit outfit set" : "New outfit set"}</DialogTitle>
          <DialogDescription>Pick the products that make the set. Sizes and colours are chosen when it&apos;s sold.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="set-name">Name</Label>
              <Input id="set-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Eid Three-Piece — Kurti + Dupatta + Plazo" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="set-price">Set price (৳)</Label>
              <Input id="set-price" type="number" inputMode="decimal" min={0} value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Products in the set</Label>
            {draft.components.map((c, index) => (
              <div key={c.productId} className="flex items-center gap-2 rounded-md border p-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{c.name}</p>
                  <p className="text-xs text-muted-foreground">
                    <span className="font-mono">{c.code}</span> · {formatBDT(c.basePrice)} each
                  </p>
                </div>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={99}
                  aria-label={`How many ${c.name} in one set`}
                  className="h-9 w-16"
                  value={c.qty}
                  onChange={(e) => setDraft({ ...draft, components: draft.components.map((x, i) => (i === index ? { ...x, qty: Math.max(1, Math.min(99, Number(e.target.value) || 1)) } : x)) })}
                />
                <span className="text-xs text-muted-foreground">per set</span>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${c.name}`} onClick={() => setDraft({ ...draft, components: draft.components.filter((_, i) => i !== index) })}>
                  <Trash2 />
                </Button>
              </div>
            ))}
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-8" placeholder="Add a product — search by name or code" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            {search.trim().length >= 2 && hits.length > 0 ? (
              <ul className="flex max-h-48 flex-col overflow-y-auto rounded-md border">
                {hits
                  .filter((h) => !draft.components.some((c) => c.productId === h.id))
                  .map((h) => (
                    <li key={h.id}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                        onClick={() => {
                          setDraft({ ...draft, components: [...draft.components, { productId: h.id, name: h.name, code: h.code, basePrice: h.basePrice, qty: 1 }] });
                          setSearch("");
                          setHits([]);
                        }}
                      >
                        <span>
                          {h.name} <span className="font-mono text-xs text-muted-foreground">{h.code}</span>
                        </span>
                        <Plus className="size-4" />
                      </button>
                    </li>
                  ))}
              </ul>
            ) : null}
            {draft.components.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Bought separately: {formatBDT(String(listValue))}
                {cost ? ` · average cost ${formatBDT(cost)}` : ""}. The set price is split over the pieces by their prices, so each piece can be returned or exchanged on its own.
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label>Packaging for the set</Label>
            <p className="text-xs text-muted-foreground">Only what the set adds (e.g. a gift box). Each product&apos;s own packaging is added automatically.</p>
            <PackagingLinesEditor materials={materials} value={draft.packaging} onChange={(packaging) => setDraft({ ...draft, packaging })} unit="per set" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="set-desc">Description (optional)</Label>
            <Textarea id="set-desc" rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </div>
          <div className="flex items-center gap-2">
            <Switch id="set-active" checked={draft.isActive} onCheckedChange={(v) => setDraft({ ...draft, isActive: v })} />
            <Label htmlFor="set-active">For sale</Label>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {canDelete ? (
            <Button variant="ghost" className="text-destructive" onClick={() => void remove()} disabled={saving}>
              <Trash2 />
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={saving || invalid}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              Save set
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
