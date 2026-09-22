"use client";

import { useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";

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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import type { SizeMaster } from "@/lib/catalog/types";

type FormState = { id?: string; name: string; sortOrder: number; isActive: boolean };
const EMPTY_FORM: FormState = { name: "", sortOrder: 0, isActive: true };

export function SizeManager({ canManage }: { canManage: boolean }) {
  const [sizes, setSizes] = useState<SizeMaster[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function load() {
    try {
      const data = await fetchJson<{ sizes: SizeMaster[] }>("/api/catalog/sizes");
      setSizes(data.sizes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load sizes.");
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount, no data-fetching lib in this project yet
    load();
  }, []);

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setDialogOpen(true);
  }

  function openEdit(size: SizeMaster) {
    setForm({ id: size.id, name: size.name, sortOrder: size.sortOrder, isActive: size.isActive });
    setFormError(null);
    setDialogOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    setFormError(null);
    try {
      if (form.id) {
        await fetchJson(`/api/catalog/sizes/${form.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: form.name, sortOrder: form.sortOrder, isActive: form.isActive }),
        });
      } else {
        await fetchJson("/api/catalog/sizes", {
          method: "POST",
          body: JSON.stringify({ name: form.name, sortOrder: form.sortOrder, isActive: form.isActive }),
        });
      }
      setDialogOpen(false);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not save size.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await fetchJson(`/api/catalog/sizes/${id}`, { method: "DELETE" });
      setDeleteTargetId(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete size.");
    }
  }

  if (!sizes) return <Skeleton className="h-48 w-full" />;

  return (
    <div className="flex flex-col gap-3">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {canManage ? (
        <div className="flex justify-end">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger render={<Button size="sm" onClick={openCreate} />}>
              <Plus />
              New size
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{form.id ? "Edit size" : "New size"}</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="size-name">Name</Label>
                  <Input id="size-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="size-sort">Sort order</Label>
                  <Input
                    id="size-sort"
                    type="number"
                    value={form.sortOrder}
                    onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="size-active">Active</Label>
                  <Switch id="size-active" checked={form.isActive} onCheckedChange={(checked) => setForm({ ...form, isActive: checked })} />
                </div>
                {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
              </div>
              <DialogFooter>
                <Button onClick={handleSave} disabled={saving || !form.name.trim()}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                  Save
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      ) : null}

      {sizes.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No sizes yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Variants</TableHead>
              <TableHead>Status</TableHead>
              {canManage ? <TableHead className="text-right">Actions</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sizes.map((size) => (
              <TableRow key={size.id}>
                <TableCell className="font-medium">{size.name}</TableCell>
                <TableCell>{size._count?.variants ?? 0}</TableCell>
                <TableCell>
                  <Badge variant={size.isActive ? "secondary" : "outline"}>{size.isActive ? "Active" : "Inactive"}</Badge>
                </TableCell>
                {canManage ? (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" onClick={() => openEdit(size)}>
                        <Pencil />
                      </Button>
                      <AlertDialog
                        open={deleteTargetId === size.id}
                        onOpenChange={(open) => setDeleteTargetId(open ? size.id : null)}
                      >
                        <AlertDialogTrigger render={<Button variant="ghost" size="icon-sm" />}>
                          <Trash2 />
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete &quot;{size.name}&quot;?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Sizes used by existing variants can&apos;t be deleted — deactivate instead.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleDelete(size.id)}>Delete</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
