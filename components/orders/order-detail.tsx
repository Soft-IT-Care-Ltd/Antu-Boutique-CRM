"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Layers, Pencil, Printer, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { OrderEditRequestBanner } from "@/components/orders/order-edit-request-banner";
import { OrderImagesField } from "@/components/orders/order-images-field";
import { OrderPaymentsPanel } from "@/components/orders/order-payments-panel";
import { OrderShipmentCard } from "@/components/orders/order-shipment-card";
import { OrderStatusControl } from "@/components/orders/order-status-control";
import { OrderTrashButton } from "@/components/orders/order-trash-button";
import { SendToSteadfastDialog } from "@/components/courier/send-to-steadfast-dialog";
import { OrderReturnsCard, type ReturnPermissions } from "@/components/returns/order-returns-card";
import type { ShipmentDetailView } from "@/lib/courier/types";
import { formatBDT } from "@/lib/money";
import { fetchJson } from "@/lib/orders/client";
import { LEAD_SOURCE_LABELS } from "@/lib/leads/constants";
import { DELIVERY_ZONE_LABELS, ORDER_STATUS_LABELS } from "@/lib/orders/constants";
import { WALK_IN_CUSTOMER_LABEL } from "@/lib/orders/customer";
import { orderUploadUrl } from "@/lib/orders/types";
import type { OrderDetail as OrderDetailType } from "@/lib/orders/types";
import { ORDER_STATUS_TONE } from "@/lib/ui/status-tone";
import type { WalletOption } from "@/lib/wallets/constants";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function OrderDetail({
  order: initialOrder,
  hasCostAccess,
  canEdit,
  canManageImages,
  canUpdateStatus,
  canReviewEditRequests,
  canRecordPayment,
  canEditPayment,
  canDeletePayment,
  canVerifyPayment,
  canRequestRefund,
  canDecideRefund,
  wallets,
  currentUserId,
  shipment,
  canSendToSteadfast,
  canOverrideCourier,
  returnPermissions,
  canDelete = false,
}: {
  order: OrderDetailType;
  hasCostAccess: boolean;
  canEdit: boolean;
  canManageImages: boolean;
  canUpdateStatus: boolean;
  canReviewEditRequests: boolean;
  canRecordPayment: boolean;
  canEditPayment: boolean;
  canDeletePayment: boolean;
  canVerifyPayment: boolean;
  canRequestRefund: boolean;
  canDecideRefund: boolean;
  wallets: WalletOption[];
  currentUserId: string;
  shipment: ShipmentDetailView | null;
  canSendToSteadfast: boolean;
  canOverrideCourier: boolean;
  returnPermissions: ReturnPermissions;
  /** order.delete — offered only while the order is a lead or cancelled (the server checks the rest). */
  canDelete?: boolean;
}) {
  const router = useRouter();
  const [order, setOrder] = useState(initialOrder);
  // A return or exchange refreshes the page (router.refresh): take the new totals and status.
  const [prevInitialOrder, setPrevInitialOrder] = useState(initialOrder);
  if (initialOrder !== prevInitialOrder) {
    setPrevInitialOrder(initialOrder);
    setOrder(initialOrder);
  }
  const [sendOpen, setSendOpen] = useState(false);
  const [images, setImages] = useState(initialOrder.images);

  const pendingEditRequest = order.editRequests.find((r) => r.status === "PENDING") ?? null;
  // P3.1 — a showroom sale has no courier, no delivery and maybe no customer.
  const isWalkIn = order.channel === "WALK_IN";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">{order.orderNo}</h1>
            <Badge variant={ORDER_STATUS_TONE[order.status]}>{ORDER_STATUS_LABELS[order.status]}</Badge>
            <Badge variant="outline">{order.channel === "ONLINE" ? "Online" : "Walk-in"}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Placed {formatDateTime(order.createdAt)} by {order.createdBy?.name ?? "—"}
            {order.lead ? (
              <>
                {" · from lead "}
                <Link href={`/leads/${order.lead.id}`} className="font-medium text-foreground underline-offset-4 hover:underline">
                  {order.lead.name}
                </Link>
                {` (${LEAD_SOURCE_LABELS[order.lead.source]})`}
              </>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isWalkIn ? (
            <Button render={<a href={`/api/pos/sales/${order.id}/receipt`} target="_blank" rel="noreferrer" />} nativeButton={false} variant="outline">
              <Printer />
              Receipt (80 mm)
            </Button>
          ) : null}
          {canSendToSteadfast && order.status === "PACKED" && !shipment ? (
            <Button onClick={() => setSendOpen(true)}>
              <Send />
              Send to Steadfast
            </Button>
          ) : null}
          {canUpdateStatus ? <OrderStatusControl order={order} onChange={setOrder} courierBooked={Boolean(shipment?.consignmentId)} canOverrideCourier={canOverrideCourier} /> : null}
          {canEdit && !order.exchangedFromOrderId ? (
            <Button render={<Link href={`/orders/${order.id}/edit`} />} nativeButton={false} variant="outline">
              <Pencil />
              Edit order
            </Button>
          ) : null}
          {canDelete && (order.status === "LEAD" || order.status === "CANCELLED") && !order.lead ? <OrderTrashButton orderId={order.id} orderNo={order.orderNo} /> : null}
        </div>
      </div>

      {pendingEditRequest ? (
        <OrderEditRequestBanner pendingRequest={pendingEditRequest} canReview={canReviewEditRequests} onResolved={setOrder} />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className={isWalkIn ? "lg:col-span-3" : "lg:col-span-2"}>
          <CardHeader>
            <CardTitle>Customer</CardTitle>
          </CardHeader>
          {order.customer ? (
            <CardContent className="grid gap-1 text-sm sm:grid-cols-2">
              <div>
                <div className="text-muted-foreground">Name</div>
                <div className="font-medium">{order.customer.name}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Phone</div>
                <div className="font-mono">{order.customer.phone}</div>
              </div>
              {order.customer.altPhone ? (
                <div>
                  <div className="text-muted-foreground">Alternate contact</div>
                  <div className="font-mono">{order.customer.altPhone}</div>
                </div>
              ) : null}
              {!isWalkIn ? (
                <div>
                  <div className="text-muted-foreground">Delivery address</div>
                  <div>
                    {[order.customer.addressDetail, order.customer.thana, order.customer.district, order.customer.division]
                      .filter(Boolean)
                      .join(", ") || "—"}
                  </div>
                </div>
              ) : null}
            </CardContent>
          ) : (
            <CardContent className="text-sm text-muted-foreground">{WALK_IN_CUSTOMER_LABEL} — no name or phone taken at the counter.</CardContent>
          )}
        </Card>

        {isWalkIn ? null : (
        <Card>
          <CardHeader>
            <CardTitle>Delivery</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Courier</span>
              <span>{order.courier?.name ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Zone</span>
              <span>{order.deliveryZone ? DELIVERY_ZONE_LABELS[order.deliveryZone] : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Delivery charge</span>
              <span>{formatBDT(order.deliveryCharge)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Expected date</span>
              <span>
                {order.expectedDeliveryDate
                  ? new Date(order.expectedDeliveryDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
                  : "—"}
              </span>
            </div>
          </CardContent>
        </Card>
        )}
      </div>

      {shipment ? <OrderShipmentCard shipment={shipment} /> : null}

      <SendToSteadfastDialog orderIds={sendOpen ? [order.id] : null} onOpenChange={setSendOpen} onDone={() => {
          // The order moved to HANDED_TO_COURIER server-side: reload it, and
          // refresh the server props so the shipment card appears.
          fetchJson<{ order: OrderDetailType }>(`/api/orders/${order.id}`)
            .then((data) => setOrder(data.order))
            .catch(() => {});
          router.refresh();
        }} />

      <Card>
        <CardHeader>
          <CardTitle>Items</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit price</TableHead>
                <TableHead className="text-right">Discount</TableHead>
                {hasCostAccess ? <TableHead className="text-right">Cost</TableHead> : null}
                <TableHead className="text-right">Line total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...order.items.filter((i) => i.setLineId === null), ...order.setLines.flatMap((s) => [s, ...order.items.filter((i) => i.setLineId === s.id)])].map((row) =>
                // P3.3 — an outfit set, then each component with its chosen size/colour.
                "itemIds" in row ? (
                  <TableRow key={row.id} className="bg-muted/40">
                    <TableCell>
                      <div className="flex items-center gap-1.5 font-medium">
                        <Layers className="size-3.5 shrink-0 text-muted-foreground" />
                        {row.name}
                      </div>
                      <div className="text-xs text-muted-foreground">Outfit set — its pieces are listed below</div>
                    </TableCell>
                    <TableCell className="text-right">{row.qty}</TableCell>
                    <TableCell className="text-right">{formatBDT(row.unitPrice)}</TableCell>
                    <TableCell className="text-right">{formatBDT(row.lineDiscount)}</TableCell>
                    {hasCostAccess ? <TableCell /> : null}
                    <TableCell className="text-right font-semibold">
                      {formatBDT(String(order.items.filter((i) => i.setLineId === row.id).reduce((sum, i) => sum + Math.round(Number(i.lineTotal) * 100), 0) / 100))}
                    </TableCell>
                  </TableRow>
                ) : (
                <TableRow key={row.id} className={row.setLineId ? "text-muted-foreground" : undefined}>
                  <TableCell className={row.setLineId ? "pl-6" : undefined}>
                    <div className="flex items-center gap-1.5 font-medium">
                      <span className="size-3 shrink-0 rounded-full border border-border" style={{ backgroundColor: row.colorHex }} />
                      {row.productName}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {row.sizeName} / {row.colorName} · <span className="font-mono">{row.sku}</span>
                    </div>
                    {row.stockOverride ? (
                      <Badge variant="destructive" className="mt-1 w-fit">
                        Stock override: {row.stockOverrideReason}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.qty}
                    {row.returnedQty > 0 ? <div className="text-xs text-amber-600">{row.returnedQty} returned</div> : null}
                  </TableCell>
                  <TableCell className="text-right">{formatBDT(row.unitPrice)}</TableCell>
                  <TableCell className="text-right">{formatBDT(row.lineDiscount)}</TableCell>
                  {hasCostAccess ? <TableCell className="text-right text-muted-foreground">{row.unitCostSnapshot ? formatBDT(row.unitCostSnapshot) : "—"}</TableCell> : null}
                  <TableCell className="text-right font-semibold">{formatBDT(row.lineTotal)}</TableCell>
                </TableRow>
                ),
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reference images</CardTitle>
        </CardHeader>
        <CardContent>
          <OrderImagesField
            mode="persisted"
            orderId={order.id}
            images={images}
            onChange={setImages}
            items={order.items.map((i) => ({ id: i.id, label: `${i.sizeName} / ${i.colorName} — ${i.sku}` }))}
            canManage={canManageImages}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {order.invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoice generated yet.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {[...order.invoices].reverse().map((invoice, idx) => (
                <a
                  key={invoice.id}
                  href={orderUploadUrl(invoice.filePath)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted"
                >
                  <span className="flex items-center gap-2">
                    <FileText className="size-4 text-muted-foreground" />
                    Version {invoice.version}
                    {idx === 0 ? <Badge variant="outline">Latest</Badge> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatDateTime(invoice.createdAt)}</span>
                </a>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Money</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span>{formatBDT(order.subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Discount</span>
                <span>- {formatBDT(order.discountTotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Delivery charge</span>
                <span>{formatBDT(order.deliveryCharge)}</span>
              </div>
              <div className="flex justify-between font-medium">
                <span>Total</span>
                <span>{formatBDT(order.total)}</span>
              </div>
              <div className="flex justify-between font-medium">
                <span>Due</span>
                <span className={Number(order.dueAmount) > 0 ? "text-amber-600" : ""}>{formatBDT(order.dueAmount)}</span>
              </div>
            </div>

            <OrderPaymentsPanel
              order={order}
              onChange={setOrder}
              canCreate={canRecordPayment}
              canEdit={canEditPayment}
              canDelete={canDeletePayment}
              canVerify={canVerifyPayment}
              canRequestRefund={canRequestRefund}
              canDecideRefund={canDecideRefund}
              wallets={wallets}
              currentUserId={currentUserId}
            />

            {order.deliveryNote ? (
              <div className="border-t pt-3">
                <p className="text-xs font-medium text-muted-foreground">Delivery instructions (sent to the courier)</p>
                <p className="text-sm">{order.deliveryNote}</p>
              </div>
            ) : null}

            {order.internalNote ? (
              <div className="border-t pt-3">
                <p className="text-xs font-medium text-muted-foreground">Internal note</p>
                <p className="text-sm">{order.internalNote}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Status history</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3">
              {order.statusHistory.map((entry) => (
                <div key={entry.id} className="flex gap-2 text-sm">
                  <div className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                  <div>
                    <p>
                      {entry.fromStatus ? `${ORDER_STATUS_LABELS[entry.fromStatus]} → ` : ""}
                      <span className="font-medium">{ORDER_STATUS_LABELS[entry.toStatus]}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(entry.createdAt)} · {entry.changedBy?.name ?? "System"}
                      {entry.note ? ` · ${entry.note}` : ""}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <OrderReturnsCard orderId={order.id} orderNo={order.orderNo} permissions={returnPermissions} />
    </div>
  );
}
