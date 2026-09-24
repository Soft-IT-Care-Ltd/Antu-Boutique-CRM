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
import { suggestColorCode } from "@/lib/catalog/codes";
import type { ColorMaster } from "@/lib/catalog/types";

type FormState = { id?: string; name: string; code: string; hexCode: string; sortOrder: number; isActive: boolean };
const EMPTY_FORM: FormState = { name: "", code: "", hexCode: "#000000", sortOrder: 0, isActive: true };

export function ColorManager({ canManage }: { canManage: boolean }) {
  const [colors, setColors] = useState<ColorMaster[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // A new colour's code is suggested from its name (Mustard Yellow → MYL), never clashing.
  const suggestedCode = !form.id && form.name.trim() ? suggestColorCode(form.name, new Set((colors ?? []).map((c) => c.code))) : null;

  async function load() {
    try {
      const data = await fetchJson<{ colors: ColorMaster[] }>("/api/catalog/colors");
      setColors(data.colors);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load colours.");
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

  function openEdit(color: ColorMaster) {
    setForm({ id: color.id, name: color.name, code: color.code, hexCode: color.hexCode, sortOrder: color.sortOrder, isActive: color.isActive });
    setFormError(null);
    setDialogOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    setFormError(null);
    try {
      if (form.id) {
        await fetchJson(`/api/catalog/colors/${form.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: form.name, code: form.code || undefined, hexCode: form.hexCode, sortOrder: form.sortOrder, isActive: form.isActive }),
        });
      } else {
        await fetchJson("/api/catalog/colors", {
          method: "POST",
          body: JSON.stringify({ name: form.name, code: form.code || suggestedCode || undefined, hexCode: form.hexCode, sortOrder: form.sortOrder, isActive: form.isActive }),
        });
      }
      setDialogOpen(false);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not save colour.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await fetchJson(`/api/catalog/colors/${id}`, { method: "DELETE" });
      setDeleteTargetId(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete colour.");
    }
  }

  if (!colors) return <Skeleton className="h-48 w-full" />;

  return (
    <div className="flex flex-col gap-3">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {canManage ? (
        <div className="flex justify-end">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger render={<Button size="sm" onClick={openCreate} />}>
              <Plus />
              New colour
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{form.id ? "Edit colour" : "New colour"}</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="color-name">Name</Label>
                  <Input id="color-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="color-code">SKU code</Label>
                  <Input
                    id="color-code"
                    className="font-mono uppercase placeholder:normal-case"
                    maxLength={3}
                    value={form.code}
                    placeholder={suggestedCode ?? "e.g. MRN"}
                    onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })}
                  />
                  <p className="text-xs text-muted-foreground">
                    2–3 letters or digits, part of every SKU in this colour{form.id ? " — can't change once tags are printed" : suggestedCode ? ` (${suggestedCode} if left blank)` : ""}.
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="color-hex">Hex code</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={/^#[0-9A-Fa-f]{6}$/.test(form.hexCode) ? form.hexCode : "#000000"}
                      onChange={(e) => setForm({ ...form, hexCode: e.target.value })}
                      className="size-8 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
                      aria-label="Pick colour"
                    />
                    <Input
                      id="color-hex"
                      value={form.hexCode}
                      onChange={(e) => setForm({ ...form, hexCode: e.target.value })}
                      placeholder="#800000"
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="color-sort">Sort order</Label>
                  <Input
                    id="color-sort"
                    type="number"
                    value={form.sortOrder}
                    onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="color-active">Active</Label>
                  <Switch id="color-active" checked={form.isActive} onCheckedChange={(checked) => setForm({ ...form, isActive: checked })} />
                </div>
                {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
              </div>
              <DialogFooter>
                <Button onClick={handleSave} disabled={saving || !form.name.trim() || !/^#[0-9A-Fa-f]{6}$/.test(form.hexCode)}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                  Save
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      ) : null}

      {colors.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No colours yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Colour</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Hex</TableHead>
              <TableHead>Variants</TableHead>
              <TableHead>Status</TableHead>
              {canManage ? <TableHead className="text-right">Actions</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {colors.map((color) => (
              <TableRow key={color.id}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    <span
                      className="size-4 shrink-0 rounded-full border border-border"
                      style={{ backgroundColor: color.hexCode }}
                    />
                    {color.name}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-sm">{color.code}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{color.hexCode}</TableCell>
                <TableCell>{color._count?.variants ?? 0}</TableCell>
                <TableCell>
                  <Badge variant={color.isActive ? "secondary" : "outline"}>{color.isActive ? "Active" : "Inactive"}</Badge>
                </TableCell>
                {canManage ? (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" onClick={() => openEdit(color)}>
                        <Pencil />
                      </Button>
                      <AlertDialog
                        open={deleteTargetId === color.id}
                        onOpenChange={(open) => setDeleteTargetId(open ? color.id : null)}
                      >
                        <AlertDialogTrigger render={<Button variant="ghost" size="icon-sm" />}>
                          <Trash2 />
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete &quot;{color.name}&quot;?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Colours used by existing variants can&apos;t be deleted — deactivate instead.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleDelete(color.id)}>Delete</AlertDialogAction>
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
