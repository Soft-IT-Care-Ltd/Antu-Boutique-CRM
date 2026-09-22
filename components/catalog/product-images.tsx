"use client";

import { useRef, useState } from "react";
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
import { ApiError, fetchJson } from "@/lib/catalog/client";
import { MAX_PRODUCT_IMAGES } from "@/lib/catalog/constants";
import type { ProductImage } from "@/lib/catalog/types";
import { uploadUrl } from "@/lib/catalog/types";

export function ProductImages({
  productId,
  initialImages,
  canEdit,
}: {
  productId: string;
  initialImages: ProductImage[];
  canEdit: boolean;
}) {
  const [images, setImages] = useState(initialImages);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    if (images.length + list.length > MAX_PRODUCT_IMAGES) {
      setError(`A product can have at most ${MAX_PRODUCT_IMAGES} images`);
      return;
    }

    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      for (const file of list) formData.append("files", file);
      const { images: created } = await fetchJson<{ images: ProductImage[] }>(`/api/catalog/products/${productId}/images`, {
        method: "POST",
        body: formData,
      });
      setImages((prev) => [...prev, ...created]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not upload image.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleDelete(imageId: string) {
    setError(null);
    try {
      await fetchJson(`/api/catalog/products/${productId}/images/${imageId}`, { method: "DELETE" });
      setImages((prev) => prev.filter((i) => i.id !== imageId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete image.");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
        {images.map((image) => (
          <div key={image.id} className="group relative aspect-square overflow-hidden rounded-lg border bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={uploadUrl(image.thumbPath)} alt="" className="size-full object-cover" />
            {canEdit ? (
              <AlertDialog>
                <AlertDialogTrigger
                  render={
                    <Button
                      variant="destructive"
                      size="icon-sm"
                      className="absolute top-1 right-1 opacity-0 transition-opacity group-hover:opacity-100"
                    />
                  }
                >
                  <Trash2 />
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this image?</AlertDialogTitle>
                    <AlertDialogDescription>This can&apos;t be undone.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleDelete(image.id)}>Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
          </div>
        ))}

        {canEdit && images.length < MAX_PRODUCT_IMAGES ? (
          <label
            className={`flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-muted-foreground transition-colors hover:bg-muted ${
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
              if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
            }}
          >
            {uploading ? <Loader2 className="size-5 animate-spin" /> : <ImagePlus className="size-5" />}
            <span className="text-xs">Add photo</span>
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && uploadFiles(e.target.files)}
            />
          </label>
        ) : null}
      </div>

      {images.length === 0 && !canEdit ? <p className="text-sm text-muted-foreground">No photos uploaded.</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
