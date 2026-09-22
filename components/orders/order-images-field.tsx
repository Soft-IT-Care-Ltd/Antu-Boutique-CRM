"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";

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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { MAX_ORDER_IMAGES } from "@/lib/orders/constants";
import { orderUploadUrl } from "@/lib/orders/types";
import type { OrderImageView } from "@/lib/orders/types";

export type StagedImage = {
  localId: string;
  file: File;
  previewUrl: string;
  caption: string;
  itemLocalId: string | null;
};

export type ItemTagOption = { id: string; label: string };

type StagedProps = {
  mode: "staged";
  images: StagedImage[];
  onChange: (images: StagedImage[]) => void;
  items: ItemTagOption[];
};

type PersistedProps = {
  mode: "persisted";
  orderId: string;
  images: OrderImageView[];
  onChange: (images: OrderImageView[]) => void;
  items: ItemTagOption[];
  canManage: boolean;
};

// PRD §4.6 section 3 — the field that differs most from Gift Valy. Always
// optional (never blocks the order), up to MAX_ORDER_IMAGES, added via file
// picker, drag-drop, or pasting a Messenger screenshot with Ctrl+V. This one
// component covers both halves of that lifecycle: "staged" holds in-memory
// Files while the order doesn't exist yet (order_no isn't known until the
// order is created), and "persisted" uploads straight to the server once it
// does — the create form switches from one to the other right after its
// POST succeeds.
export function OrderImagesField(props: StagedProps | PersistedProps) {
  const { items } = props;
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const canManage = props.mode === "staged" ? true : props.canManage;
  const count = props.images.length;

  useEffect(() => {
    if (!canManage) return;
    function onPaste(e: ClipboardEvent) {
      const dataTransferItems = e.clipboardData?.items;
      if (!dataTransferItems) return;
      const files: File[] = [];
      for (const item of Array.from(dataTransferItems)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void addFiles(files);
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, count]);

  useEffect(() => {
    return () => {
      if (props.mode === "staged") {
        for (const img of props.images) URL.revokeObjectURL(img.previewUrl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    if (count + files.length > MAX_ORDER_IMAGES) {
      setError(`An order can have at most ${MAX_ORDER_IMAGES} reference images`);
      return;
    }
    setError(null);

    if (props.mode === "staged") {
      const next: StagedImage[] = files.map((file) => ({
        localId: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
        caption: "",
        itemLocalId: null,
      }));
      props.onChange([...props.images, ...next]);
      return;
    }

    setUploading(true);
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);
        const { image } = await fetchJson<{ image: OrderImageView }>(`/api/orders/${props.orderId}/images`, {
          method: "POST",
          body: formData,
        });
        props.onChange([...props.images, image]);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not upload image.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function removeStaged(localId: string) {
    if (props.mode !== "staged") return;
    const target = props.images.find((i) => i.localId === localId);
    if (target) URL.revokeObjectURL(target.previewUrl);
    props.onChange(props.images.filter((i) => i.localId !== localId));
  }

  function updateStaged(localId: string, patch: Partial<StagedImage>) {
    if (props.mode !== "staged") return;
    props.onChange(props.images.map((i) => (i.localId === localId ? { ...i, ...patch } : i)));
  }

  async function deletePersisted(imageId: string) {
    if (props.mode !== "persisted") return;
    setError(null);
    try {
      await fetchJson(`/api/orders/${props.orderId}/images/${imageId}`, { method: "DELETE" });
      props.onChange(props.images.filter((i) => i.id !== imageId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete image.");
    }
  }

  async function updatePersisted(imageId: string, patch: { caption?: string | null; orderItemId?: string | null }) {
    if (props.mode !== "persisted") return;
    try {
      const { image } = await fetchJson<{ image: OrderImageView }>(`/api/orders/${props.orderId}/images/${imageId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      props.onChange(props.images.map((i) => (i.id === imageId ? image : i)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update image.");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {props.mode === "staged"
          ? props.images.map((img) => (
              <div key={img.localId} className="group relative flex flex-col gap-1 overflow-hidden rounded-lg border bg-muted p-1.5">
                <div className="relative aspect-square overflow-hidden rounded-md bg-background">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.previewUrl} alt="" className="size-full object-cover" />
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon-sm"
                    className="absolute top-1 right-1"
                    onClick={() => removeStaged(img.localId)}
                  >
                    <Trash2 />
                  </Button>
                </div>
                <Input
                  value={img.caption}
                  onChange={(e) => updateStaged(img.localId, { caption: e.target.value })}
                  placeholder="Caption (optional)"
                  className="h-7 text-xs"
                />
                {items.length > 0 ? (
                  <Select
                    value={img.itemLocalId ?? "none"}
                    onValueChange={(v) => updateStaged(img.localId, { itemLocalId: v === "none" ? null : (v as string) })}
                  >
                    <SelectTrigger className="h-7 w-full text-xs">
                      <SelectValue placeholder="Tag to item">
                        {(value: string) => (value === "none" ? "No line item" : (items.find((it) => it.id === value)?.label ?? "Tag to item"))}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No line item</SelectItem>
                      {items.map((it) => (
                        <SelectItem key={it.id} value={it.id}>
                          {it.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </div>
            ))
          : props.images.map((img) => (
              <div key={img.id} className="group relative flex flex-col gap-1 overflow-hidden rounded-lg border bg-muted p-1.5">
                <div className="relative aspect-square overflow-hidden rounded-md bg-background">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={orderUploadUrl(img.thumbPath)} alt="" className="size-full object-cover" />
                  {canManage ? (
                    <AlertDialog>
                      <AlertDialogTrigger render={<Button type="button" variant="destructive" size="icon-sm" className="absolute top-1 right-1" />}>
                        <Trash2 />
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this photo?</AlertDialogTitle>
                          <AlertDialogDescription>This can&apos;t be undone.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => deletePersisted(img.id)}>Delete</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : null}
                </div>
                {canManage ? (
                  <>
                    <Input
                      defaultValue={img.caption ?? ""}
                      onBlur={(e) => {
                        if (e.target.value !== (img.caption ?? "")) updatePersisted(img.id, { caption: e.target.value || null });
                      }}
                      placeholder="Caption (optional)"
                      className="h-7 text-xs"
                    />
                    {items.length > 0 ? (
                      <Select
                        value={img.orderItemId ?? "none"}
                        onValueChange={(v) => updatePersisted(img.id, { orderItemId: v === "none" ? null : (v as string) })}
                      >
                        <SelectTrigger className="h-7 w-full text-xs">
                          <SelectValue placeholder="Tag to item">
                            {(value: string) => (value === "none" ? "No line item" : (items.find((it) => it.id === value)?.label ?? "Tag to item"))}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No line item</SelectItem>
                          {items.map((it) => (
                            <SelectItem key={it.id} value={it.id}>
                              {it.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : null}
                  </>
                ) : img.caption ? (
                  <p className="truncate text-xs text-muted-foreground">{img.caption}</p>
                ) : null}
              </div>
            ))}

        {canManage && count < MAX_ORDER_IMAGES ? (
          <label
            className={`flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-2 text-center text-muted-foreground transition-colors hover:bg-muted ${
              dragOver ? "border-primary bg-muted" : ""
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files.length > 0) void addFiles(Array.from(e.dataTransfer.files));
            }}
          >
            {uploading ? <Loader2 className="size-5 animate-spin" /> : <ImagePlus className="size-5" />}
            <span className="text-xs">Add, drop, or paste (Ctrl+V)</span>
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && void addFiles(Array.from(e.target.files))}
            />
          </label>
        ) : null}
      </div>

      {count === 0 && !canManage ? <p className="text-sm text-muted-foreground">No reference photos.</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <p className="text-xs text-muted-foreground">
        Optional — up to {MAX_ORDER_IMAGES} photos, JPEG/PNG/WebP, 5MB each. Packing sees these first.
      </p>
    </div>
  );
}
