"use client";

import Link from "next/link";
import { useState } from "react";
import { ImageOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ImageLightbox } from "@/components/packing/image-lightbox";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import { packingUploadUrl } from "@/lib/packing/types";
import type { PackingQueueItem } from "@/lib/packing/types";
import { ShelfSpots } from "@/components/shelves/shelf-spots";

// PRD §4.8: "each queue card shows the order's reference-image thumbnails
// at the top, then items with size and colour in bold, qty, and the
// internal note." Clicking a thumbnail opens the lightbox in place;
// clicking anywhere else on the card opens the packing detail screen.
export function PackingQueueCard({ order }: { order: PackingQueueItem }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  return (
    <>
      <Card className={order.isOverdue ? "ring-2 ring-destructive" : undefined}>
        <CardHeader className="flex-row items-start justify-between gap-2">
          <Link href={`/packing/${order.id}`} className="font-mono text-sm font-semibold hover:underline">
            {order.orderNo}
          </Link>
          {order.packedAt ? (
            <Badge variant="outline">Packed {formatDhakaDateTime(order.packedAt)}</Badge>
          ) : (
            <Badge variant={order.isOverdue ? "destructive" : "secondary"}>
              {order.isOverdue ? "Overdue" : `${Math.max(0, Math.round(order.hoursOpen))}h`}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {order.images.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {order.images.map((image, i) => (
                <button
                  key={image.id}
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setLightboxIndex(i);
                  }}
                  className="size-14 shrink-0 overflow-hidden rounded-md border bg-muted"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={packingUploadUrl(image.thumbPath)} alt="" className="size-full object-cover" />
                </button>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ImageOff className="size-3.5" />
              No reference photos
            </div>
          )}

          <Link href={`/packing/${order.id}`} className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-muted-foreground">{order.customer.name}</p>
            <ul className="flex flex-col gap-0.5 text-sm">
              {order.items.map((item, i) => (
                <li key={item.id} className={item.set ? "pl-3" : undefined}>
                  {/* P3.3 — a set is never just its name: every piece is its own line. */}
                  {item.set && order.items[i - 1]?.set?.id !== item.set.id ? (
                    <span className="-ml-3 block text-xs font-medium text-muted-foreground">
                      {item.set.name} × {item.set.qty} (outfit set)
                    </span>
                  ) : null}
                  {item.set ? "↳ " : ""}
                  {item.productName} — <strong>{item.sizeName}</strong> / <strong>{item.colorName}</strong> · Qty {item.qty}
                  {item.shelves ? <ShelfSpots value={item.shelves} className="mt-0.5" /> : null}
                </li>
              ))}
            </ul>
            {order.internalNote ? <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">{order.internalNote}</p> : null}
          </Link>
        </CardContent>
      </Card>
      <ImageLightbox images={order.images} index={lightboxIndex} onIndexChange={setLightboxIndex} />
    </>
  );
}
