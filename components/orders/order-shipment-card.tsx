"use client";

import { AlertTriangle, ExternalLink, Truck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatWeight, SHIPMENT_SUB_STATUS_LABELS } from "@/lib/courier/constants";
import type { ShipmentDetailView } from "@/lib/courier/types";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { DELIVERY_ZONE_LABELS } from "@/lib/orders/constants";

// The courier side of an order: consignment, live Steadfast status and the
// tracking timeline (tracking_update webhooks, stored UTC, shown in Dhaka
// time). Courier cost only renders when the server left it in (product.cost.view).
export function OrderShipmentCard({ shipment }: { shipment: ShipmentDetailView }) {
  const cost = shipment.courierCostActual ?? shipment.courierCostEstimate;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Truck className="size-4" /> Shipment — {shipment.courierName}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1 text-sm">
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Consignment</span>
            <span className="font-mono">{shipment.consignmentId ?? "—"}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Tracking</span>
            {shipment.trackingUrl ? (
              <a href={shipment.trackingUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-mono text-primary hover:underline">
                {shipment.trackingCode ?? "Open"} <ExternalLink className="size-3" />
              </a>
            ) : (
              <span className="font-mono">{shipment.trackingCode ?? "—"}</span>
            )}
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Courier status</span>
            <span className="flex flex-wrap justify-end gap-1">
              <Badge variant="outline" className="font-mono">
                {shipment.steadfastStatus ?? "—"}
              </Badge>
              {shipment.subStatus && !shipment.finalizedAt ? <Badge variant="secondary">{SHIPMENT_SUB_STATUS_LABELS[shipment.subStatus]}</Badge> : null}
              {shipment.onHold ? <Badge variant="destructive">On hold</Badge> : null}
            </span>
          </div>
          {shipment.orderStatus === "IN_TRANSIT" ? (
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Rider</span>
              <span>
                —{" "}
                {shipment.trackingUrl ? (
                  <a href={shipment.trackingUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    view tracking page
                  </a>
                ) : null}
              </span>
            </div>
          ) : null}
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Booked</span>
            <span>
              {shipment.bookedAt ? formatDhakaDateTime(shipment.bookedAt) : "—"}
              {shipment.bookedBy ? ` · ${shipment.bookedBy}` : ""}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">Zone / weight</span>
            <span>
              {shipment.zone ? DELIVERY_ZONE_LABELS[shipment.zone] : "—"} · {formatWeight(shipment.weightGrams)}
            </span>
          </div>
          {shipment.codAmount !== undefined ? (
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">COD</span>
              <span>
                {formatBDT(shipment.codAmount)}
                {shipment.codCollected ? ` · collected ${formatBDT(shipment.codCollected)}` : ""}
              </span>
            </div>
          ) : null}
          {"courierCostEstimate" in shipment ? (
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Courier cost</span>
              <span>{cost ? `${formatBDT(cost)} ${shipment.courierCostActual ? "(actual)" : "(estimate)"}` : "—"}</span>
            </div>
          ) : null}
          {shipment.needsAttention && shipment.attentionReason ? (
            <p className="mt-1 flex items-start gap-1 text-xs text-amber-600">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {shipment.attentionReason}
            </p>
          ) : null}
          {shipment.accountsReviewRequired ? <p className="mt-1 text-xs text-amber-600">Partial delivery — waiting for Accounts to review the money.</p> : null}
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">Tracking timeline</p>
          {shipment.trackingEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tracking updates from Steadfast yet.</p>
          ) : (
            <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
              {shipment.trackingEvents.map((e) => (
                <div key={e.id} className="flex gap-2 text-sm">
                  <div className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                  <div>
                    <p>{e.message}</p>
                    <p className="text-xs text-muted-foreground">{formatDhakaDateTime(e.eventAt)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
