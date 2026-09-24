"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Loader2, Tags } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, fetchJson } from "@/lib/catalog/client";
import { ALLOCATION_METHOD_LABELS, formatDhakaDate, formatDhakaDateTime } from "@/lib/inventory/constants";
import type { PurchaseDetail as PurchaseDetailData } from "@/lib/inventory/types";
import { formatBDT } from "@/lib/money";

/** Lines are read-only (they already moved stock and WAC); only the supplier-payment side can be edited. */
export function PurchaseDetail({ initial, canPrintTags = false }: { initial: PurchaseDetailData; canPrintTags?: boolean }) {
  const [purchase, setPurchase] = useState(initial);
  const [amountPaid, setAmountPaid] = useState(initial.amountPaid);
  const [invoiceNo, setInvoiceNo] = useState(initial.invoiceNo ?? "");
  const [note, setNote] = useState(initial.note ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const dirty = Number(amountPaid) !== Number(purchase.amountPaid) || invoiceNo !== (purchase.invoiceNo ?? "") || note !== (purchase.note ?? "");
  const due = Number(purchase.dueAmount);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const data = await fetchJson<{ purchase: PurchaseDetailData }>(`/api/inventory/purchases/${purchase.id}`, {
        method: "PATCH",
        body: JSON.stringify({ amountPaid: Number(amountPaid), invoiceNo: invoiceNo || null, note: note || null }),
      });
      setPurchase(data.purchase);
      setAmountPaid(data.purchase.amountPaid);
      setMessage({ kind: "ok", text: "Saved." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof ApiError ? err.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{purchase.supplier.name}</CardTitle>
            <CardDescription>
              {formatDhakaDate(purchase.purchaseDate)}
              {purchase.invoiceNo ? ` · Invoice ${purchase.invoiceNo}` : ""}
              {purchase.supplier.phone ? ` · ${purchase.supplier.phone}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
              <dt className="text-muted-foreground">Items</dt>
              <dd className="tabular-nums">{formatBDT(purchase.itemsSubtotal)}</dd>
              <dt className="text-muted-foreground">Transport</dt>
              <dd className="tabular-nums">{formatBDT(purchase.transportCost)}</dd>
              <dt className="text-muted-foreground">Other</dt>
              <dd className="tabular-nums">{formatBDT(purchase.otherCost)}</dd>
              <dt className="text-muted-foreground">Spread</dt>
              <dd>{ALLOCATION_METHOD_LABELS[purchase.allocationMethod]}</dd>
              <dt className="font-medium">Total</dt>
              <dd className="font-semibold tabular-nums">{formatBDT(purchase.totalCost)}</dd>
              <dt className="text-muted-foreground">Paid</dt>
              <dd className="tabular-nums">{formatBDT(purchase.amountPaid)}</dd>
              <dt className="text-muted-foreground">Due</dt>
              <dd>{due > 0 ? <Badge variant="destructive">{formatBDT(purchase.dueAmount)}</Badge> : <Badge variant="secondary">Paid in full</Badge>}</dd>
            </dl>
            <p className="pt-3 text-xs text-muted-foreground">
              Recorded by {purchase.createdByName ?? "—"} on {formatDhakaDateTime(purchase.createdAt)}.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Supplier payment</CardTitle>
            <CardDescription>Due is always total − paid; it can&apos;t be typed.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pd-paid">Total paid so far (৳)</Label>
              <Input id="pd-paid" type="number" inputMode="decimal" min={0} step="0.01" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pd-invoice">Supplier invoice no.</Label>
              <Input id="pd-invoice" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pd-note">Note</Label>
              <Textarea id="pd-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            {message ? <p className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{message.text}</p> : null}
            <Button onClick={save} disabled={saving || !dirty || amountPaid.trim() === ""}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              Save
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2 space-y-0">
          <div>
            <CardTitle>Items</CardTitle>
            <CardDescription>Landed cost = unit cost + this line&apos;s share of transport/other. That is what feeds the weighted average.</CardDescription>
          </div>
          {canPrintTags ? (
            <Button render={<Link href={`/catalog/price-tags?purchaseId=${initial.id}`} />} nativeButton={false} variant="outline" size="sm">
              <Tags />
              Print tags for everything received
            </Button>
          ) : null}
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Variant</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit cost</TableHead>
                <TableHead className="text-right">Share</TableHead>
                <TableHead className="text-right">Landed / unit</TableHead>
                <TableHead>Avg cost</TableHead>
                <TableHead>Stock</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {purchase.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className="font-medium">{item.productName}</div>
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="size-3 shrink-0 rounded-full border border-border" style={{ backgroundColor: item.colorHex }} />
                      <span className="font-semibold">
                        {item.sizeName} / {item.colorName}
                      </span>
                      <Link href={`/inventory/movements?variantId=${item.variantId}`} className="font-mono text-muted-foreground hover:underline">
                        {item.sku}
                      </Link>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{item.qty}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatBDT(item.unitCost)}</TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">{formatBDT(item.allocatedCost)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatBDT(item.landedUnitCost)}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    <span className="text-muted-foreground">{formatBDT(item.wacBefore)}</span>
                    <ArrowRight className="mx-1 inline size-3 text-muted-foreground" />
                    <span className="font-medium">{formatBDT(item.wacAfter)}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    <span className="text-muted-foreground">{item.stockBefore}</span>
                    <ArrowRight className="mx-1 inline size-3 text-muted-foreground" />
                    <span className="font-medium">{item.stockBefore + item.qty}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
