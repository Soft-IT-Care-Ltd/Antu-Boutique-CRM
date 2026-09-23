"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Search, Truck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import type { SupplierItem } from "@/lib/inventory/types";
import { formatBDT } from "@/lib/money";

type FormState = { id?: string; name: string; phone: string; address: string; notes: string; isActive: boolean };
const EMPTY_FORM: FormState = { name: "", phone: "", address: "", notes: "", isActive: true };

export function SupplierManager() {
  const [suppliers, setSuppliers] = useState<SupplierItem[] | null>(null);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    const params = new URLSearchParams({ includeInactive: String(showInactive) });
    if (debouncedQ) params.set("q", debouncedQ);
    fetchJson<{ suppliers: SupplierItem[] }>(`/api/inventory/suppliers?${params.toString()}`)
      .then((data) => {
        setSuppliers(data.suppliers);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load suppliers."));
  }, [debouncedQ, showInactive, reloadKey]);

  async function save() {
    if (!form) return;
    setSaving(true);
    setFormError(null);
    const body = { name: form.name, phone: form.phone, address: form.address, notes: form.notes };
    try {
      if (form.id) {
        await fetchJson(`/api/inventory/suppliers/${form.id}`, { method: "PATCH", body: JSON.stringify({ ...body, isActive: form.isActive }) });
      } else {
        await fetchJson("/api/inventory/suppliers", { method: "POST", body: JSON.stringify(body) });
      }
      setForm(null);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not save supplier.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search name or phone..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={showInactive} onCheckedChange={setShowInactive} />
            Show inactive
          </label>
        </div>
        <Button
          onClick={() => {
            setForm(EMPTY_FORM);
            setFormError(null);
          }}
        >
          <Plus />
          New supplier
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!suppliers ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : suppliers.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <Truck className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No suppliers yet</p>
          <p className="text-sm text-muted-foreground">Add the wholesalers and workshops you buy from.</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Supplier</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead className="text-right">Purchases</TableHead>
              <TableHead className="text-right">Due to supplier</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {suppliers.map((s) => (
              <TableRow key={s.id} className={s.isActive ? undefined : "opacity-60"}>
                <TableCell>
                  <div className="flex items-center gap-2 font-medium">
                    {s.name}
                    {s.isActive ? null : <Badge variant="outline">Inactive</Badge>}
                  </div>
                  {s.address ? <div className="text-xs text-muted-foreground">{s.address}</div> : null}
                </TableCell>
                <TableCell className="font-mono text-sm">{s.phone ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {s.purchaseCount > 0 ? (
                    <Link href={`/inventory/purchases?supplierId=${s.id}`} className="hover:underline">
                      {s.purchaseCount}
                    </Link>
                  ) : (
                    0
                  )}
                </TableCell>
                <TableCell className={`text-right tabular-nums ${Number(s.totalDue) > 0 ? "font-semibold text-destructive" : "text-muted-foreground"}`}>
                  {formatBDT(s.totalDue)}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${s.name}`}
                    onClick={() => {
                      setForm({ id: s.id, name: s.name, phone: s.phone ?? "", address: s.address ?? "", notes: s.notes ?? "", isActive: s.isActive });
                      setFormError(null);
                    }}
                  >
                    <Pencil />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={form !== null} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form?.id ? "Edit supplier" : "New supplier"}</DialogTitle>
          </DialogHeader>
          {form ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="supplier-name">Name</Label>
                <Input id="supplier-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="supplier-phone">Phone</Label>
                <Input id="supplier-phone" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="supplier-address">Address</Label>
                <Input id="supplier-address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="supplier-notes">Notes</Label>
                <Textarea id="supplier-notes" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
              {form.id ? (
                <div className="flex items-center justify-between">
                  <Label htmlFor="supplier-active">Active</Label>
                  <Switch id="supplier-active" checked={form.isActive} onCheckedChange={(checked) => setForm({ ...form, isActive: checked })} />
                </div>
              ) : null}
              {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={save} disabled={saving || !form?.name.trim()}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
