import Link from "next/link";
import { ArrowLeft, Download, PackagePlus } from "lucide-react";

import { PrintButton } from "@/components/orders/print-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { getWaitingForStock } from "@/lib/fulfilment/waiting";
import { PURCHASE_VIEW_PERMISSIONS } from "@/lib/inventory/queries";
import { formatBDT } from "@/lib/money";
import { prisma } from "@/lib/prisma";

// C5 — CORRECTIONS.md item 12: every order waiting for a piece that isn't in
// stock anywhere, oldest first (they get the stock first too), with the
// totals and what to buy. Printable; CSV; one click pre-fills a purchase.

const dateOf = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "Asia/Dhaka" });

export default async function WaitingForStockPage() {
  const user = await guardPage("/orders");
  const [data, canPurchase] = await Promise.all([getWaitingForStock(prisma, user), can(user, PURCHASE_VIEW_PERMISSIONS, "all")]);
  const prefill = data.needs.map((n) => `${n.variantId}:${n.qty}`).join(",");

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-6xl md:p-6 print:p-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/orders?tab=waiting_for_stock" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground print:hidden">
            <ArrowLeft className="size-3.5" /> Orders
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Waiting for stock</h1>
          <p className="text-sm text-muted-foreground">Orders with a piece that isn&apos;t in stock anywhere. When it arrives — a purchase, a transfer, a return — the oldest order gets it first and moves on by itself.</p>
        </div>
        <div className="flex flex-wrap gap-2 print:hidden">
          <PrintButton />
          <Button variant="outline" render={<a href="/api/orders/waiting-for-stock?format=csv" download />} nativeButton={false}>
            <Download />
            CSV
          </Button>
          {canPurchase && data.needs.length > 0 ? (
            <Button render={<Link href={`/inventory/purchases/new?prefill=${encodeURIComponent(prefill)}`} />} nativeButton={false}>
              <PackagePlus />
              Pre-fill a purchase
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Figure label="Orders waiting" value={String(data.totals.orders)} />
        <Figure label="Parcel value" value={formatBDT(data.totals.parcelValue)} />
        <Figure label="Pieces needed" value={String(data.totals.units)} />
      </div>

      {data.orders.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">No order is waiting for stock.</CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>What to get</CardTitle>
              <CardDescription>Per size and colour, the pieces the waiting orders need.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">Needed</TableHead>
                    <TableHead className="text-right">Orders</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.needs.map((n) => (
                    <TableRow key={n.variantId}>
                      <TableCell>
                        <span className="flex items-center gap-1.5">
                          <span className="size-3 shrink-0 rounded-full border" style={{ backgroundColor: n.colorHex }} />
                          {n.productName} · <b>{n.sizeName}</b> / {n.colorName}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{n.sku}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{n.qty}</TableCell>
                      <TableCell className="text-right tabular-nums">{n.orders}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Orders</CardTitle>
              <CardDescription>Oldest first — the order they get stock in.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Missing</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="text-right">Waiting</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.orders.map((o) => (
                    <TableRow key={o.orderId} className="align-top">
                      <TableCell>
                        <Link href={`/orders/${o.orderId}`} className="font-mono font-medium underline-offset-4 hover:underline">
                          {o.orderNo}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {dateOf(o.placedAt)}
                          {o.createdByName ? ` · ${o.createdByName}` : ""}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div>{o.customerName ?? "—"}</div>
                        <div className="font-mono text-xs text-muted-foreground">{o.customerPhone}</div>
                      </TableCell>
                      <TableCell>
                        <ul className="flex flex-col gap-0.5 text-sm">
                          {o.missing.map((m) => (
                            <li key={m.variantId}>
                              {m.qty} × {m.productName} · <b>{m.sizeName}</b> / {m.colorName} <span className="font-mono text-xs text-muted-foreground">{m.sku}</span>
                            </li>
                          ))}
                        </ul>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatBDT(o.total)}</TableCell>
                      <TableCell className="text-right">
                        <span className="tabular-nums">{o.daysWaiting === 0 ? "today" : `${o.daysWaiting} d`}</span>
                        {o.expectedOn ? (
                          <Badge variant="outline" className="ml-1">
                            exp. {dateOf(o.expectedOn)}
                          </Badge>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <Card size="sm">
      <CardContent>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}
