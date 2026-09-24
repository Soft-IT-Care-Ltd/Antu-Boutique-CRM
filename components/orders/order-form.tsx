"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2, UserCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { OrderImagesField, type StagedImage } from "@/components/orders/order-images-field";
import { OrderItemPicker, type PickedVariant } from "@/components/orders/order-item-picker";
import { WalletSelect } from "@/components/wallets/wallet-select";
import { newLocalId } from "@/lib/browser/local-id";
import { isValidBdPhone } from "@/lib/customers/phone";
import { BD_DIVISIONS } from "@/lib/customers/constants";
import type { CustomerListItem } from "@/lib/customers/types";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_VALUES } from "@/lib/orders/constants";
import type { PaymentMethodValue } from "@/lib/orders/constants";
import type { CourierCompanyOption, OrderDetail, OrderImageView } from "@/lib/orders/types";
import { walletsForMethod, type WalletOption } from "@/lib/wallets/constants";

type ItemRow = {
  localId: string;
  variantId: string;
  productName: string;
  sku: string;
  sizeName: string;
  colorName: string;
  colorHex: string;
  qty: number;
  unitPrice: string;
  lineDiscount: string;
  // null for a pre-existing (edit mode) row until the user picks a fresh
  // variant — we don't have a live number for it without a re-fetch, and
  // the server re-validates authoritatively either way.
  available: number | null;
  weightedAvgCost?: string;
  stockOverrideReason: string;
};

type CustomerFormState = {
  customerId: string | null;
  name: string;
  phone: string;
  altPhone: string;
  division: string | null;
  district: string;
  thana: string;
  addressDetail: string;
};

function itemsFromOrder(order: OrderDetail): ItemRow[] {
  return order.items.map((item) => ({
    localId: item.id,
    variantId: item.variantId,
    productName: item.productName,
    sku: item.sku,
    sizeName: item.sizeName,
    colorName: item.colorName,
    colorHex: item.colorHex,
    qty: item.qty,
    unitPrice: item.unitPrice,
    lineDiscount: item.lineDiscount,
    available: null,
    weightedAvgCost: item.unitCostSnapshot ?? undefined,
    stockOverrideReason: item.stockOverrideReason ?? "",
  }));
}

export function OrderForm({
  order,
  hasCostAccess,
  canStockOverride,
  couriers,
  wallets = [],
}: {
  order?: OrderDetail;
  hasCostAccess: boolean;
  canStockOverride: boolean;
  couriers: CourierCompanyOption[];
  /** Active wallets, for which one the advance went into (P2.3). */
  wallets?: WalletOption[];
}) {
  const router = useRouter();
  const isEdit = Boolean(order);

  const [customer, setCustomer] = useState<CustomerFormState>(() =>
    order?.customer
      ? {
          customerId: order.customer.id,
          name: order.customer.name,
          phone: order.customer.phone,
          altPhone: order.customer.altPhone ?? "",
          division: order.customer.division,
          district: order.customer.district ?? "",
          thana: order.customer.thana ?? "",
          addressDetail: order.customer.addressDetail ?? "",
        }
      : { customerId: null, name: "", phone: "", altPhone: "", division: null, district: "", thana: "", addressDetail: "" },
  );
  const [customerMatches, setCustomerMatches] = useState<CustomerListItem[]>([]);
  const [customerSearching, setCustomerSearching] = useState(false);

  const [items, setItems] = useState<ItemRow[]>(() => (order ? itemsFromOrder(order) : []));

  const [courierId, setCourierId] = useState<string | null>(order?.courier?.id ?? null);
  const [courierZoneId, setCourierZoneId] = useState<string | null>(order?.courierZoneId ?? null);
  const [deliveryCharge, setDeliveryCharge] = useState(order?.deliveryCharge ?? "0");
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState(order?.expectedDeliveryDate?.slice(0, 10) ?? "");
  const [internalNote, setInternalNote] = useState(order?.internalNote ?? "");
  const [deliveryNote, setDeliveryNote] = useState(order?.deliveryNote ?? "");

  const [advanceEnabled, setAdvanceEnabled] = useState(false);
  const [advanceMethod, setAdvanceMethod] = useState<PaymentMethodValue>("BKASH");
  const [advanceAmount, setAdvanceAmount] = useState("");
  const [advanceTxnId, setAdvanceTxnId] = useState("");
  const [advanceWalletId, setAdvanceWalletId] = useState(() => walletsForMethod(wallets, "BKASH")[0]?.id ?? "");
  const advanceWallets = walletsForMethod(wallets, advanceMethod);

  const [stagedImages, setStagedImages] = useState<StagedImage[]>([]);
  const [persistedImages, setPersistedImages] = useState<OrderImageView[]>(order?.images ?? []);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Phone search-as-you-type against existing customers (PRD §4.4/§4.6
  // section 1). Only runs while placing a brand-new order for a customer
  // that hasn't been picked yet — editing an existing order's customer
  // isn't supported here, see the read-only card below.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (isEdit || customer.customerId) {
        setCustomerMatches([]);
        return;
      }
      const phone = customer.phone.trim();
      if (phone.length < 3) {
        setCustomerMatches([]);
        return;
      }
      setCustomerSearching(true);
      fetchJson<{ items: CustomerListItem[] }>(`/api/customers?q=${encodeURIComponent(phone)}&pageSize=5`)
        .then((data) => setCustomerMatches(data.items))
        .catch(() => setCustomerMatches([]))
        .finally(() => setCustomerSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [customer.phone, customer.customerId, isEdit]);

  function selectExistingCustomer(match: CustomerListItem) {
    setCustomer({
      customerId: match.id,
      name: match.name,
      phone: match.phone,
      altPhone: match.altPhone ?? "",
      division: match.division,
      district: match.district ?? "",
      thana: match.thana ?? "",
      addressDetail: "",
    });
    setCustomerMatches([]);
  }

  function changeCustomer() {
    setCustomer({ customerId: null, name: "", phone: "", altPhone: "", division: null, district: "", thana: "", addressDetail: "" });
  }

  function addItem(variant: PickedVariant) {
    setItems((prev) => [
      ...prev,
      {
        localId: newLocalId(),
        variantId: variant.variantId,
        productName: variant.productName,
        sku: variant.sku,
        sizeName: variant.sizeName,
        colorName: variant.colorName,
        colorHex: variant.colorHex,
        qty: 1,
        unitPrice: variant.effectivePrice,
        lineDiscount: "0",
        available: variant.available,
        weightedAvgCost: variant.weightedAvgCost,
        stockOverrideReason: "",
      },
    ]);
  }

  function updateItem(localId: string, patch: Partial<ItemRow>) {
    setItems((prev) => prev.map((i) => (i.localId === localId ? { ...i, ...patch } : i)));
  }

  function removeItem(localId: string) {
    setItems((prev) => prev.filter((i) => i.localId !== localId));
    setStagedImages((prev) => prev.map((img) => (img.itemLocalId === localId ? { ...img, itemLocalId: null } : img)));
  }

  const itemTagOptions = useMemo(
    () => items.map((i) => ({ id: i.localId, label: `${i.sizeName} / ${i.colorName} — ${i.sku}` })),
    [items],
  );

  const selectedCourier = couriers.find((c) => c.id === courierId) ?? null;

  const subtotal = items.reduce((sum, i) => sum + i.qty * (Number(i.unitPrice) || 0), 0);
  const discountTotal = items.reduce((sum, i) => sum + (Number(i.lineDiscount) || 0), 0);
  const total = subtotal - discountTotal + (Number(deliveryCharge) || 0);
  const advanceAmountNum = advanceEnabled ? Number(advanceAmount) || 0 : 0;
  const dueAfterAdvance = total - advanceAmountNum;

  const overStockRows = items.filter((i) => i.available !== null && i.qty > i.available);
  const blockedByStock = overStockRows.some((i) => !canStockOverride || !i.stockOverrideReason.trim());

  const canSubmit =
    items.length > 0 &&
    (customer.customerId || (customer.name.trim() && isValidBdPhone(customer.phone))) &&
    !blockedByStock;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);

    const itemsPayload = items.map((i) => ({
      variantId: i.variantId,
      qty: i.qty,
      unitPrice: Number(i.unitPrice) || 0,
      lineDiscount: Number(i.lineDiscount) || 0,
      ...(i.available !== null && i.qty > i.available && i.stockOverrideReason.trim()
        ? { stockOverrideReason: i.stockOverrideReason.trim() }
        : {}),
    }));

    try {
      if (isEdit && order) {
        await fetchJson(`/api/orders/${order.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            items: itemsPayload,
            courierId: courierId || null,
            courierZoneId: courierZoneId || null,
            deliveryCharge: Number(deliveryCharge) || 0,
            expectedDeliveryDate: expectedDeliveryDate || null,
            internalNote: internalNote || null,
            deliveryNote: deliveryNote || null,
          }),
        });
        router.push(`/orders/${order.id}`);
        return;
      }

      const payload: Record<string, unknown> = {
        items: itemsPayload,
        courierId: courierId || null,
        courierZoneId: courierZoneId || null,
        deliveryCharge: Number(deliveryCharge) || 0,
        expectedDeliveryDate: expectedDeliveryDate || null,
        internalNote: internalNote || null,
        deliveryNote: deliveryNote || null,
      };
      if (customer.customerId) {
        payload.customerId = customer.customerId;
      } else {
        payload.customer = {
          name: customer.name,
          phone: customer.phone,
          altPhone: customer.altPhone || null,
          division: customer.division,
          district: customer.district || null,
          thana: customer.thana || null,
          addressDetail: customer.addressDetail || null,
        };
      }
      if (advanceEnabled && advanceAmountNum > 0) {
        payload.advancePayment = {
          method: advanceMethod,
          amount: advanceAmountNum,
          walletId: advanceWallets.some((w) => w.id === advanceWalletId) ? advanceWalletId : undefined,
          transactionId: advanceTxnId.trim() || undefined,
        };
      }

      const { order: created, itemIds } = await fetchJson<{ order: OrderDetail; itemIds: string[] }>("/api/orders", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (stagedImages.length > 0) {
        const itemIdByLocal = new Map(items.map((i, idx) => [i.localId, itemIds[idx]]));
        for (const staged of stagedImages) {
          const formData = new FormData();
          formData.append("file", staged.file);
          if (staged.caption.trim()) formData.append("caption", staged.caption.trim());
          const taggedId = staged.itemLocalId ? itemIdByLocal.get(staged.itemLocalId) : undefined;
          if (taggedId) formData.append("orderItemId", taggedId);
          await fetchJson(`/api/orders/${created.id}/images`, { method: "POST", body: formData }).catch(() => {
            // An image upload failure shouldn't block navigating to the
            // created order (PRD §4.6 section 3: images never block the
            // order) — the user can retry from the order detail page.
          });
        }
      }

      router.push(`/orders/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save order.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>1. Customer</CardTitle>
          <CardDescription>One person — the buyer is the recipient. No payer/recipient split.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isEdit || customer.customerId ? (
            <div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/40 p-3">
              <div className="flex items-start gap-2">
                <UserCheck className="mt-0.5 size-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">{customer.name}</p>
                  <p className="font-mono text-sm text-muted-foreground">{customer.phone}</p>
                  <p className="text-sm text-muted-foreground">
                    {[customer.addressDetail, customer.thana, customer.district, customer.division].filter(Boolean).join(", ") ||
                      "No address on file"}
                  </p>
                </div>
              </div>
              {!isEdit ? (
                <Button type="button" variant="outline" size="sm" onClick={changeCustomer}>
                  Change
                </Button>
              ) : null}
            </div>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="order-customer-phone">Phone</Label>
                  <Input
                    id="order-customer-phone"
                    value={customer.phone}
                    onChange={(e) => setCustomer((c) => ({ ...c, phone: e.target.value }))}
                    placeholder="017XXXXXXXX"
                    inputMode="tel"
                    required
                  />
                  {customerSearching ? <p className="text-xs text-muted-foreground">Searching...</p> : null}
                  {customerMatches.length > 0 ? (
                    <div className="flex flex-col gap-1 rounded-lg border p-1.5">
                      {customerMatches.map((match) => (
                        <button
                          key={match.id}
                          type="button"
                          onClick={() => selectExistingCustomer(match)}
                          className="flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                        >
                          <span>{match.name}</span>
                          <span className="font-mono text-xs text-muted-foreground">{match.phone}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="order-customer-name">Name</Label>
                  <Input
                    id="order-customer-name"
                    value={customer.name}
                    onChange={(e) => setCustomer((c) => ({ ...c, name: e.target.value }))}
                    required
                  />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="order-customer-alt">
                    Alternate contact number <span className="text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id="order-customer-alt"
                    value={customer.altPhone}
                    onChange={(e) => setCustomer((c) => ({ ...c, altPhone: e.target.value }))}
                    placeholder="017XXXXXXXX"
                    inputMode="tel"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Division</Label>
                  <Select
                    value={customer.division ?? "none"}
                    onValueChange={(v) => setCustomer((c) => ({ ...c, division: v === "none" ? null : (v as string) }))}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select division" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not set</SelectItem>
                      {BD_DIVISIONS.map((d) => (
                        <SelectItem key={d} value={d}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="order-customer-district">District</Label>
                  <Input
                    id="order-customer-district"
                    value={customer.district}
                    onChange={(e) => setCustomer((c) => ({ ...c, district: e.target.value }))}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="order-customer-thana">Thana / Upazila</Label>
                  <Input
                    id="order-customer-thana"
                    value={customer.thana}
                    onChange={(e) => setCustomer((c) => ({ ...c, thana: e.target.value }))}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="order-customer-address">Delivery address detail</Label>
                <Textarea
                  id="order-customer-address"
                  value={customer.addressDetail}
                  onChange={(e) => setCustomer((c) => ({ ...c, addressDetail: e.target.value }))}
                  rows={2}
                  placeholder="House, road, area..."
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Items</CardTitle>
          <CardDescription>Search by product name or SKU, then pick the size + colour variant.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <OrderItemPicker onPick={addItem} />

          {items.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No items added yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Qty</TableHead>
                  <TableHead>Unit price</TableHead>
                  <TableHead>Discount</TableHead>
                  <TableHead>Stock</TableHead>
                  <TableHead>Line total</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const isOver = item.available !== null && item.qty > item.available;
                  const lineTotal = item.qty * (Number(item.unitPrice) || 0) - (Number(item.lineDiscount) || 0);
                  return (
                    <TableRow key={item.localId}>
                      <TableCell>
                        <div className="flex items-center gap-1.5 font-medium">
                          <span className="size-3 shrink-0 rounded-full border border-border" style={{ backgroundColor: item.colorHex }} />
                          {item.productName}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {item.sizeName} / {item.colorName} · <span className="font-mono">{item.sku}</span>
                        </div>
                        {hasCostAccess && item.weightedAvgCost ? (
                          <div className="text-xs text-muted-foreground">Cost: {formatBDT(item.weightedAvgCost)}</div>
                        ) : null}
                        {isOver ? (
                          <div className="mt-1 flex flex-col gap-1">
                            <Badge variant="destructive" className="w-fit">
                              Only {item.available} available
                            </Badge>
                            {canStockOverride ? (
                              <Input
                                value={item.stockOverrideReason}
                                onChange={(e) => updateItem(item.localId, { stockOverrideReason: e.target.value })}
                                placeholder="Reason to override (required)"
                                className="h-7 text-xs"
                              />
                            ) : (
                              <p className="text-xs text-destructive">Only Admin/Manager can sell below available stock.</p>
                            )}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min={1}
                          value={item.qty}
                          onChange={(e) => updateItem(item.localId, { qty: Math.max(1, Number(e.target.value) || 1) })}
                          className="h-8 w-16"
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          value={item.unitPrice}
                          onChange={(e) => updateItem(item.localId, { unitPrice: e.target.value })}
                          className="h-8 w-24"
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          value={item.lineDiscount}
                          onChange={(e) => updateItem(item.localId, { lineDiscount: e.target.value })}
                          className="h-8 w-24"
                        />
                      </TableCell>
                      <TableCell>
                        {item.available === null ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <Badge variant={isOver ? "destructive" : "secondary"}>{item.available}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-medium">{formatBDT(lineTotal)}</TableCell>
                      <TableCell>
                        <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeItem(item.localId)}>
                          <Trash2 />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Reference images</CardTitle>
          <CardDescription>
            Optional — customers often send a photo instead of naming the item. Packing sees these first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isEdit && order ? (
            <OrderImagesField
              mode="persisted"
              orderId={order.id}
              images={persistedImages}
              onChange={setPersistedImages}
              items={itemTagOptions}
              canManage
            />
          ) : (
            <OrderImagesField mode="staged" images={stagedImages} onChange={setStagedImages} items={itemTagOptions} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>4. Delivery and money</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label>Courier</Label>
              <Select
                value={courierId ?? "none"}
                onValueChange={(v) => {
                  const next = v === "none" ? null : (v as string);
                  setCourierId(next);
                  setCourierZoneId(null);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select courier">
                    {(value: string) => (value === "none" ? "Not set" : (couriers.find((c) => c.id === value)?.name ?? "Select courier"))}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not set</SelectItem>
                  {couriers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Zone</Label>
              <Select
                value={courierZoneId ?? "none"}
                onValueChange={(v) => {
                  const next = v === "none" ? null : (v as string);
                  setCourierZoneId(next);
                  const zone = selectedCourier?.zones.find((z) => z.id === next);
                  if (zone) setDeliveryCharge(zone.charge);
                }}
                disabled={!selectedCourier}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select zone">
                    {(value: string) => {
                      if (value === "none") return "Not set";
                      const zone = selectedCourier?.zones.find((z) => z.id === value);
                      return zone ? zone.zone.replaceAll("_", " ") : "Select zone";
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not set</SelectItem>
                  {selectedCourier?.zones.map((z) => (
                    <SelectItem key={z.id} value={z.id}>
                      {z.zone.replaceAll("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="order-delivery-charge">Delivery charge (৳)</Label>
              <Input
                id="order-delivery-charge"
                type="number"
                min={0}
                step="0.01"
                value={deliveryCharge}
                onChange={(e) => setDeliveryCharge(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="order-expected-date">Expected delivery date</Label>
              <Input
                id="order-expected-date"
                type="date"
                value={expectedDeliveryDate}
                onChange={(e) => setExpectedDeliveryDate(e.target.value)}
              />
            </div>
          </div>

          {!isEdit ? (
            <div className="flex flex-col gap-3 rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="order-advance-toggle">Take advance payment now</Label>
                  <p className="text-xs text-muted-foreground">Optional — full advance, partial, or skip for full COD.</p>
                </div>
                <Switch id="order-advance-toggle" checked={advanceEnabled} onCheckedChange={setAdvanceEnabled} />
              </div>
              {advanceEnabled ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label>Method</Label>
                    <Select
                      value={advanceMethod}
                      onValueChange={(v) => {
                        const method = v as PaymentMethodValue;
                        setAdvanceMethod(method);
                        setAdvanceWalletId(walletsForMethod(wallets, method)[0]?.id ?? "");
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue>{(value: PaymentMethodValue) => PAYMENT_METHOD_LABELS[value]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {PAYMENT_METHOD_VALUES.map((m) => (
                          <SelectItem key={m} value={m}>
                            {PAYMENT_METHOD_LABELS[m]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="order-advance-amount">Amount (৳)</Label>
                    <Input
                      id="order-advance-amount"
                      type="number"
                      min={0}
                      step="0.01"
                      value={advanceAmount}
                      onChange={(e) => setAdvanceAmount(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="order-advance-wallet">Received into</Label>
                    {advanceWallets.length > 0 ? (
                      <WalletSelect id="order-advance-wallet" wallets={advanceWallets} value={advanceWalletId} onChange={setAdvanceWalletId} />
                    ) : (
                      <p className="text-sm text-muted-foreground">No active {PAYMENT_METHOD_LABELS[advanceMethod]} wallet.</p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="order-advance-txn">Transaction ID</Label>
                    <Input id="order-advance-txn" value={advanceTxnId} onChange={(e) => setAdvanceTxnId(e.target.value)} />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="order-delivery-note">Delivery instructions for the rider</Label>
            <Input
              id="order-delivery-note"
              value={deliveryNote}
              maxLength={200}
              onChange={(e) => setDeliveryNote(e.target.value)}
              placeholder="e.g. Call before coming, gate 3. Sent to the courier — no internal info."
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="order-internal-note">Internal note</Label>
            <Textarea
              id="order-internal-note"
              value={internalNote}
              onChange={(e) => setInternalNote(e.target.value)}
              rows={2}
              placeholder="Visible to staff only, never printed for the customer."
            />
          </div>

          <div className="flex flex-col gap-1 rounded-lg bg-muted/40 p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{formatBDT(subtotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Discount</span>
              <span>- {formatBDT(discountTotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Delivery charge</span>
              <span>{formatBDT(Number(deliveryCharge) || 0)}</span>
            </div>
            <div className="flex justify-between font-medium">
              <span>Total</span>
              <span>{formatBDT(total)}</span>
            </div>
            {!isEdit && advanceEnabled ? (
              <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Advance paid</span>
                  <span>- {formatBDT(advanceAmountNum)}</span>
                </div>
                <div className="flex justify-between font-medium">
                  <span>Due</span>
                  <span>{formatBDT(dueAfterAdvance)}</span>
                </div>
              </>
            ) : null}
            {isEdit && order ? (
              <p className="pt-1 text-xs text-muted-foreground">
                Due amount is recalculated by the server after saving (currently {formatBDT(order.dueAmount)}).
              </p>
            ) : null}
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2 pb-6">
        <Button type="submit" disabled={saving || !canSubmit}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {isEdit ? "Save changes" : "Create order"}
        </Button>
      </div>
    </form>
  );
}
