"use client";

import { useEffect, useState } from "react";
import { Banknote, CreditCard, Loader2, Smartphone, UserRound, X } from "lucide-react";

import { WalletSelect } from "@/components/wallets/wallet-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CustomerListItem } from "@/lib/customers/types";
import { isValidBdPhone } from "@/lib/customers/phone";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { formatBDT } from "@/lib/money";
import { fetchJson } from "@/lib/orders/client";
import { PAYMENT_METHOD_LABELS } from "@/lib/orders/constants";
import { POS_PAYMENT_METHODS, type PosPaymentMethod } from "@/lib/pos/constants";
import { walletsForMethod, type WalletOption } from "@/lib/wallets/constants";

export type Tender = { key: string; method: PosPaymentMethod; amount: string; tendered: string; walletId: string; transactionId: string };

export type CustomerInput = { phone: string; name: string };

const METHOD_ICON: Record<PosPaymentMethod, typeof Banknote> = { CASH: Banknote, BKASH: Smartphone, NAGAD: Smartphone, CARD: CreditCard };

/** Round-up note suggestions for cash handed over (৳ 850 → 900, 1000, 2000). */
function cashSuggestions(amountPaisa: number): number[] {
  const taka = Math.ceil(amountPaisa / 100);
  const out = new Set<number>();
  for (const step of [100, 500, 1000]) {
    const up = Math.ceil(taka / step) * step;
    if (up > taka) out.add(up);
  }
  return [...out].sort((a, b) => a - b).slice(0, 3);
}

export function PosCheckout({
  subtotalPaisa,
  discountPaisa,
  totalPaisa,
  cartError,
  cartDiscount,
  cartDiscountMode,
  onCartDiscount,
  customer,
  onCustomer,
  tenders,
  onAddTender,
  onChangeTender,
  onRemoveTender,
  wallets,
  cashAllowed,
  cashBlockedReason,
  note,
  onNote,
  canComplete,
  busy,
  onComplete,
  phoneRef,
}: {
  subtotalPaisa: number;
  discountPaisa: number;
  totalPaisa: number;
  cartError: string | null;
  cartDiscount: string;
  cartDiscountMode: "AMOUNT" | "PERCENT";
  onCartDiscount: (value: string, mode: "AMOUNT" | "PERCENT") => void;
  customer: CustomerInput;
  onCustomer: (c: CustomerInput) => void;
  tenders: Tender[];
  onAddTender: (method: PosPaymentMethod) => void;
  onChangeTender: (key: string, patch: Partial<Tender>) => void;
  onRemoveTender: (key: string) => void;
  wallets: WalletOption[];
  cashAllowed: boolean;
  cashBlockedReason: string | null;
  note: string;
  onNote: (v: string) => void;
  canComplete: boolean;
  busy: boolean;
  onComplete: () => void;
  phoneRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [found, setFound] = useState<{ phone: string; customer: CustomerListItem | null } | null>(null);
  const phoneOk = customer.phone.trim() !== "" && isValidBdPhone(customer.phone);
  // Only a lookup for the number now in the box counts.
  const match = phoneOk && found?.phone === customer.phone.trim() ? found.customer : null;

  // A returning customer (one this user can see) is recognised by phone.
  useEffect(() => {
    if (!phoneOk) return;
    const phone = customer.phone.trim();
    const timer = setTimeout(() => {
      fetchJson<{ items: CustomerListItem[] }>(`/api/customers?q=${encodeURIComponent(phone)}&pageSize=1`)
        .then((d) => setFound({ phone, customer: d.items[0] ?? null }))
        .catch(() => setFound({ phone, customer: null }));
    }, 250);
    return () => clearTimeout(timer);
  }, [customer.phone, phoneOk]);

  const paid = tenders.reduce((a, t) => a + toPaisa(Number(t.amount) || 0), 0);
  const remaining = totalPaisa - paid;
  const change = tenders.reduce((a, t) => (t.method === "CASH" && t.tendered ? a + Math.max(0, toPaisa(Number(t.tendered) || 0) - toPaisa(Number(t.amount) || 0)) : a), 0);

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2 rounded-xl border p-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Subtotal</span>
          <span className="tabular-nums">{formatBDT(fromPaisa(subtotalPaisa))}</span>
        </div>
        <div className="flex items-center justify-between gap-2 text-sm">
          <Label htmlFor="pos-cart-discount" className="text-muted-foreground">
            Discount on the whole sale
          </Label>
          <div className="flex items-center gap-1">
            <Input
              id="pos-cart-discount"
              className="h-10 w-24 text-right tabular-nums"
              inputMode="decimal"
              placeholder="0"
              value={cartDiscount}
              onChange={(e) => onCartDiscount(e.target.value, cartDiscountMode)}
            />
            <div className="flex overflow-hidden rounded-lg border" role="group" aria-label="Discount type">
              {(["AMOUNT", "PERCENT"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={cartDiscountMode === mode}
                  className={`h-10 w-10 text-sm ${cartDiscountMode === mode ? "bg-primary text-primary-foreground" : "bg-background"}`}
                  onClick={() => onCartDiscount(cartDiscount, mode)}
                >
                  {mode === "AMOUNT" ? "৳" : "%"}
                </button>
              ))}
            </div>
          </div>
        </div>
        {discountPaisa > 0 ? (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Total discount</span>
            <span className="tabular-nums">− {formatBDT(fromPaisa(discountPaisa))}</span>
          </div>
        ) : null}
        <div className="flex items-baseline justify-between border-t pt-2">
          <span className="font-medium">Total</span>
          <span className="text-2xl font-semibold tabular-nums">{formatBDT(fromPaisa(totalPaisa))}</span>
        </div>
        {cartError ? <p className="text-sm text-destructive">{cartError}</p> : null}
      </section>

      <section className="flex flex-col gap-2 rounded-xl border p-3">
        <Label htmlFor="pos-phone" className="flex items-center gap-1.5">
          <UserRound className="size-4" /> Customer <span className="font-normal text-muted-foreground">(optional · F4)</span>
        </Label>
        <Input
          id="pos-phone"
          ref={phoneRef}
          className="h-11 text-base"
          inputMode="tel"
          autoComplete="off"
          placeholder="Phone number — leave blank for anonymous"
          value={customer.phone}
          onChange={(e) => onCustomer({ ...customer, phone: e.target.value })}
        />
        {customer.phone.trim() && !phoneOk ? <p className="text-xs text-destructive">Enter a valid number, e.g. 017XXXXXXXX</p> : null}
        {phoneOk && match ? (
          <p className="text-sm">
            Returning customer: <b>{match.name}</b>
          </p>
        ) : phoneOk ? (
          <Input className="h-11 text-base" placeholder="Name (optional)" value={customer.name} onChange={(e) => onCustomer({ ...customer, name: e.target.value })} />
        ) : null}
      </section>

      <section className="flex flex-col gap-2 rounded-xl border p-3">
        <p className="text-sm font-medium">Payment</p>
        <div className="grid grid-cols-4 gap-2">
          {POS_PAYMENT_METHODS.map((m) => {
            const Icon = METHOD_ICON[m];
            const blocked = m === "CASH" && !cashAllowed;
            return (
              <Button key={m} type="button" variant="outline" className="h-14 flex-col gap-0.5 text-xs" disabled={blocked || remaining <= 0} onClick={() => onAddTender(m)}>
                <Icon className="size-5" />
                {PAYMENT_METHOD_LABELS[m]}
              </Button>
            );
          })}
        </div>
        {!cashAllowed && cashBlockedReason ? <p className="text-xs text-amber-700 dark:text-amber-400">{cashBlockedReason}</p> : null}

        {tenders.map((t) => {
          const matching = walletsForMethod(wallets, t.method);
          const tChange = t.method === "CASH" && t.tendered ? toPaisa(Number(t.tendered) || 0) - toPaisa(Number(t.amount) || 0) : 0;
          return (
            <div key={t.key} className="flex flex-col gap-2 rounded-lg bg-muted/50 p-2">
              <div className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-sm font-medium">{PAYMENT_METHOD_LABELS[t.method]}</span>
                <Input className="h-11 flex-1 text-right text-base tabular-nums" inputMode="decimal" aria-label={`${PAYMENT_METHOD_LABELS[t.method]} amount`} value={t.amount} onChange={(e) => onChangeTender(t.key, { amount: e.target.value })} />
                <Button type="button" variant="ghost" className="size-11" aria-label="Remove payment" onClick={() => onRemoveTender(t.key)}>
                  <X />
                </Button>
              </div>
              {t.method === "CASH" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Input className="h-10 w-28 text-right tabular-nums" inputMode="decimal" placeholder="Cash given" aria-label="Cash handed over" value={t.tendered} onChange={(e) => onChangeTender(t.key, { tendered: e.target.value })} />
                  {cashSuggestions(toPaisa(Number(t.amount) || 0)).map((n) => (
                    <Button key={n} type="button" variant="outline" className="h-10" onClick={() => onChangeTender(t.key, { tendered: String(n) })}>
                      {formatBDT(n)}
                    </Button>
                  ))}
                  {tChange > 0 ? <span className="ml-auto text-sm font-semibold">Change {formatBDT(fromPaisa(tChange))}</span> : null}
                  {tChange < 0 && t.tendered ? <span className="ml-auto text-sm text-destructive">Less than the cash amount</span> : null}
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {t.method !== "CARD" ? (
                    <Input className="h-10 flex-1 font-mono uppercase placeholder:normal-case" placeholder="TrxID (recommended)" aria-label="Transaction ID" value={t.transactionId} onChange={(e) => onChangeTender(t.key, { transactionId: e.target.value })} />
                  ) : null}
                  {matching.length > 1 ? <WalletSelect wallets={matching} value={t.walletId} onChange={(v) => onChangeTender(t.key, { walletId: v })} className="h-10 w-44" /> : null}
                </div>
              )}
            </div>
          );
        })}

        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{remaining > 0 ? "Still to pay" : remaining < 0 ? "Paid too much" : "Paid in full"}</span>
          <span className={`font-semibold tabular-nums ${remaining !== 0 ? "text-destructive" : "text-emerald-700 dark:text-emerald-400"}`}>{formatBDT(fromPaisa(Math.abs(remaining)))}</span>
        </div>
        {change > 0 ? (
          <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-2 py-1.5 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
            <span className="text-sm">Give change</span>
            <span className="text-lg font-semibold tabular-nums">{formatBDT(fromPaisa(change))}</span>
          </div>
        ) : null}
      </section>

      <Input className="h-10" placeholder="Note for staff (optional)" value={note} onChange={(e) => onNote(e.target.value)} />

      <Button type="button" className="h-14 text-base" disabled={!canComplete || busy} onClick={onComplete}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        Complete sale · {formatBDT(fromPaisa(totalPaisa))} <span className="text-xs opacity-80">(F9)</span>
      </Button>
    </div>
  );
}
