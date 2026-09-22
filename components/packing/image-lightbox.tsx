"use client";

import { useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { packingUploadUrl } from "@/lib/packing/types";
import type { PackingImageView } from "@/lib/packing/types";

// PRD §4.8: "clicking a thumbnail opens a full-size viewer with
// next/previous through that order's images." Controlled by the parent
// (index === null means closed) so a queue card and the detail page can
// both drive it from their own thumbnail grid.
export function ImageLightbox({
  images,
  index,
  onIndexChange,
}: {
  images: PackingImageView[];
  index: number | null;
  onIndexChange: (index: number | null) => void;
}) {
  const open = index !== null;
  const current = index !== null ? images[index] : null;

  useEffect(() => {
    if (index === null) return;
    function onKey(e: KeyboardEvent) {
      if (index === null) return;
      if (e.key === "ArrowRight") onIndexChange((index + 1) % images.length);
      if (e.key === "ArrowLeft") onIndexChange((index - 1 + images.length) % images.length);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, images.length, onIndexChange]);

  if (!current || index === null) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onIndexChange(null)}>
      <DialogContent className="max-w-2xl p-2 sm:max-w-2xl">
        <div className="relative flex items-center justify-center overflow-hidden rounded-lg bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={packingUploadUrl(current.filePath)} alt={current.caption ?? ""} className="max-h-[70vh] w-full object-contain" />
          {images.length > 1 ? (
            <>
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                className="absolute top-1/2 left-2 -translate-y-1/2"
                onClick={() => onIndexChange(index === null ? null : (index - 1 + images.length) % images.length)}
              >
                <ChevronLeft />
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                className="absolute top-1/2 right-2 -translate-y-1/2"
                onClick={() => onIndexChange(index === null ? null : (index + 1) % images.length)}
              >
                <ChevronRight />
              </Button>
            </>
          ) : null}
        </div>
        <div className="flex items-center justify-between px-1 text-sm text-muted-foreground">
          <span>{current.caption || "Reference photo"}</span>
          {images.length > 1 ? (
            <span>
              {(index ?? 0) + 1} / {images.length}
            </span>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
