"use client";

import { useState } from "react";
import { FileText, ImageOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ImageLightbox } from "@/components/packing/image-lightbox";
import { PackChecklistDialog } from "@/components/packing/pack-checklist-dialog";
import { ORDER_STATUS_LABELS } from "@/lib/orders/constants";
import { packingUploadUrl } from "@/lib/packing/types";
import type { PackingOrderDetail as PackingOrderDetailData } from "@/lib/packing/types";
import { ORDER_STATUS_TONE } from "@/lib/ui/status-tone";

export function PackingOrderDetail({ order: initialOrder, canPack }: { order: PackingOrderDetailData; canPack: boolean }) {
  const [order, setOrder] = useState(initialOrder);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const address = [order.customer.addressDetail, order.customer.thana, order.customer.district, order.customer.division]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-mono text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">{order.orderNo}</h1>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant={ORDER_STATUS_TONE[order.status]}>{ORDER_STATUS_LABELS[order.status]}</Badge>
            {order.status === "CONFIRMED" && order.isOverdue ? <Badge variant="destructive">Overdue</Badge> : null}
          </div>
        </div>
        <div className="flex gap-2">
          {order.status !== "CONFIRMED" ? (
            <Button
              variant="outline"
              nativeButton={false}
              render={<a href={`/api/packing/${order.id}/slip`} target="_blank" rel="noreferrer" />}
            >
              <FileText />
              Print packing slip
            </Button>
          ) : null}
          {canPack && order.status === "CONFIRMED" ? <PackChecklistDialog orderId={order.id} onPacked={setOrder} /> : null}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Deliver to</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          <p className="font-medium">{order.customer.name}</p>
          <p className="text-muted-foreground">{order.customer.phone}</p>
          {order.customer.altPhone ? <p className="text-muted-foreground">Alt: {order.customer.altPhone}</p> : null}
          <p className="text-muted-foreground">{address || "No address on file"}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reference photos</CardTitle>
        </CardHeader>
        <CardContent>
          {order.images.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {order.images.map((image, i) => (
                <button
                  key={image.id}
                  type="button"
                  onClick={() => setLightboxIndex(i)}
                  className="size-20 overflow-hidden rounded-md border bg-muted"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={packingUploadUrl(image.thumbPath)} alt="" className="size-full object-cover" />
                </button>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <ImageOff className="size-4" />
              No reference photos — sold from the item description only.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Items</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y">
            {order.items.map((item, i) => (
              <li key={item.id} className={`flex flex-wrap items-center justify-between py-2 text-sm ${item.set ? "pl-4" : ""}`}>
                {/* P3.3 — the set's name heads its pieces; each piece is picked on its own. */}
                {item.set && order.items[i - 1]?.set?.id !== item.set.id ? (
                  <p className="-ml-4 w-full pb-1 text-xs font-semibold text-muted-foreground">
                    {item.set.name} × {item.set.qty} — outfit set, pack every piece
                  </p>
                ) : null}
                <div>
                  <p>
                    {item.set ? "↳ " : ""}
                    {item.productName}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">{item.sku}</p>
                </div>
                <div className="text-right">
                  <p>
                    <strong>{item.sizeName}</strong> / <strong>{item.colorName}</strong>
                  </p>
                  <p className="text-muted-foreground">Qty {item.qty}</p>
                </div>
              </li>
            ))}
          </ul>
          {order.packaging.length > 0 ? (
            <div className="mt-3 rounded-md bg-muted/50 p-2.5 text-sm">
              <p className="text-xs font-medium text-muted-foreground">{order.packedAt ? "Packaging used" : "Packaging to use"}</p>
              <p>{order.packaging.map((p) => `${p.qty} × ${p.label}`).join(" · ")}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {order.internalNote ? (
        <Card>
          <CardHeader>
            <CardTitle>Internal note</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">{order.internalNote}</CardContent>
        </Card>
      ) : null}

      {order.packedBy ? (
        <p className="text-sm text-muted-foreground">
          Packed by {order.packedBy.name}
          {order.packedAt ? ` on ${new Date(order.packedAt).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}
        </p>
      ) : null}

      <ImageLightbox images={order.images} index={lightboxIndex} onIndexChange={setLightboxIndex} />
    </div>
  );
}
