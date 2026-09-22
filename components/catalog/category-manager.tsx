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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import type { Category } from "@/lib/catalog/types";

type FormState = {
  id?: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
};

const EMPTY_FORM: FormState = { name: "", parentId: null, sortOrder: 0, isActive: true };

export function CategoryManager({ canManage }: { canManage: boolean }) {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function load() {
    try {
      const data = await fetchJson<{ categories: Category[] }>("/api/catalog/categories");
      setCategories(data.categories);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load categories.");
    }
  }

  useEffect(() => {
    // No data-fetching library (SWR/React Query) in this project yet — plain
    // fetch-on-mount is the established pattern for these list screens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setDialogOpen(true);
  }

  function openEdit(category: Category) {
    setForm({
      id: category.id,
      name: category.name,
      parentId: category.parentId,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
    });
    setFormError(null);
    setDialogOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    setFormError(null);
    try {
      if (form.id) {
        await fetchJson(`/api/catalog/categories/${form.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: form.name, parentId: form.parentId, sortOrder: form.sortOrder, isActive: form.isActive }),
        });
      } else {
        await fetchJson("/api/catalog/categories", {
          method: "POST",
          body: JSON.stringify({ name: form.name, parentId: form.parentId, sortOrder: form.sortOrder, isActive: form.isActive }),
        });
      }
      setDialogOpen(false);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not save category.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await fetchJson(`/api/catalog/categories/${id}`, { method: "DELETE" });
      setDeleteTargetId(null);
      await load();
    } catch (err) {
      // Left open on failure (e.g. category still in use) so the message below is visible.
      setError(err instanceof ApiError ? err.message : "Could not delete category.");
    }
  }

  const topLevel = (categories ?? []).filter((c) => !c.parentId);

  if (!categories) {
    return <Skeleton className="h-48 w-full" />;
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {canManage ? (
        <div className="flex justify-end">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger render={<Button size="sm" onClick={openCreate} />}>
              <Plus />
              New category
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{form.id ? "Edit category" : "New category"}</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cat-name">Name</Label>
                  <Input id="cat-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Parent category (optional, one level only)</Label>
                  <Select
                    value={form.parentId ?? "none"}
                    onValueChange={(value) => setForm({ ...form, parentId: value === "none" ? null : (value as string) })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None (top-level)</SelectItem>
                      {topLevel
                        .filter((c) => c.id !== form.id)
                        .map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cat-sort">Sort order</Label>
                  <Input
                    id="cat-sort"
                    type="number"
                    value={form.sortOrder}
                    onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="cat-active">Active</Label>
                  <Switch id="cat-active" checked={form.isActive} onCheckedChange={(checked) => setForm({ ...form, isActive: checked })} />
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

      {categories.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No categories yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Parent</TableHead>
              <TableHead>Products</TableHead>
              <TableHead>Status</TableHead>
              {canManage ? <TableHead className="text-right">Actions</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {categories.map((category) => (
              <TableRow key={category.id}>
                <TableCell className="font-medium">{category.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  {category.parentId ? categories.find((c) => c.id === category.parentId)?.name ?? "—" : "—"}
                </TableCell>
                <TableCell>{category._count?.products ?? 0}</TableCell>
                <TableCell>
                  <Badge variant={category.isActive ? "secondary" : "outline"}>{category.isActive ? "Active" : "Inactive"}</Badge>
                </TableCell>
                {canManage ? (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" onClick={() => openEdit(category)}>
                        <Pencil />
                      </Button>
                      <AlertDialog
                        open={deleteTargetId === category.id}
                        onOpenChange={(open) => setDeleteTargetId(open ? category.id : null)}
                      >
                        <AlertDialogTrigger render={<Button variant="ghost" size="icon-sm" />}>
                          <Trash2 />
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete &quot;{category.name}&quot;?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This can&apos;t be undone. Categories used by products or sub-categories can&apos;t be deleted —
                              deactivate them instead.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleDelete(category.id)}>Delete</AlertDialogAction>
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
