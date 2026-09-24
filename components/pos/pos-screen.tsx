"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Banknote, CheckCircle2, Printer, ReceiptText, Repeat2 } from "lucide-react";

import { PosCart, type CartLine } from "@/components/pos/pos-cart";
import { PosCheckout, type CustomerInput, type Tender } from "@/components/pos/pos-checkout";
import { PosSearch, type PosSearchHandle } from "@/components/pos/pos-search";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CounterExchangeDialog } from "@/components/returns/counter-exchange-dialog";
import { newLocalId } from "@/lib/browser/local-id";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { PAYMENT_METHOD_LABELS } from "@/lib/orders/constants";
import { CartError, priceCart, type PricedCart } from "@/lib/pos/cart";
import type { PosPaymentMethod } from "@/lib/pos/constants";
import type { DrawerState, PosRecentSale, PosSaleResult, PosVariantHit } from "@/lib/pos/types";
import { walletsForMethod, type WalletOption } from "@/lib/wallets/constants";

const EMPTY_CUSTOMER: CustomerInput = { phone: "", name: "" };

/**
 * The 80 mm thermal receipt (lib/pos/receipt.ts) — a plain GET, opened
 * straight from the click, so it prints on any browser.
 */
function openReceipt(orderId: string) {
  window.open(`/api/pos/sales/${orderId}/receipt`, "_blank");
}

/** Opens the sale's A4 invoice PDF in a new tab. The tab is opened inside the click, so no pop-up blocker (iPad Safari) stops it. */
async function openInvoice(orderId: string): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const { url } = await fetchJson<{ url: string }>(`/api/pos/sales/${orderId}/invoice`, { method: "POST" });
    if (tab) tab.location.href = url;
    else window.location.href = url;
  } catch (err) {
    tab?.close();
    throw err;
  }
}

/**
 * PRD §4.7 — the showroom counter. Keyboard-first on a desktop (a scanner
 * is a keyboard), big touch targets on a tablet:
 *   F2 search/scan · F4 customer phone · F8 exact cash · F9 or Ctrl+Enter complete
 */
export function PosScreen({
  initialDrawer,
  drawerError,
  wallets,
  canSellOutOfStock,
  canManageDrawer,
  canExchange = false,
}: {
  initialDrawer: DrawerState | null;
  drawerError: string | null;
  wallets: WalletOption[];
  canSellOutOfStock: boolean;
  canManageDrawer: boolean;
  /** P3.2 — exchange.create: swap an item the customer brought back. */
  canExchange?: boolean;
}) {
  const searchRef = useRef<PosSearchHandle>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const checkoutRef = useRef<HTMLDivElement>(null);

  const [lines, setLines] = useState<CartLine[]>([]);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [cartDiscount, setCartDiscount] = useState("");
  const [cartDiscountMode, setCartDiscountMode] = useState<"AMOUNT" | "PERCENT">("AMOUNT");
  const [customer, setCustomer] = useState<CustomerInput>(EMPTY_CUSTOMER);
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<PosSaleResult | null>(null);
  const [printing, setPrinting] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState | null>(initialDrawer);
  const [exchangeOpen, setExchangeOpen] = useState(false);
  const [recent, setRecent] = useState<PosRecentSale[]>([]);

  const refreshSide = useCallback(() => {
    fetchJson<{ state: DrawerState }>("/api/pos/drawer")
      .then((d) => setDrawer(d.state))
      .catch(() => {});
    fetchJson<{ sales: PosRecentSale[] }>("/api/pos/sales")
      .then((d) => setRecent(d.sales))
      .catch(() => {});
  }, []);
  useEffect(() => refreshSide(), [refreshSide]);

  // Cash needs today's drawer open (lib/pos/drawer.ts lockOpenDrawerForSale).
  const todaysDrawer = drawer?.drawer && drawer.drawer.businessDay === drawer.today ? drawer.drawer : null;
  const cashAllowed = todaysDrawer?.status === "OPEN";
  const cashBlockedReason = drawerError
    ? drawerError
    : drawer?.drawer && drawer.drawer.businessDay !== drawer.today
      ? `The ${drawer.drawer.businessDay} drawer was never closed — count and close it, then open today's to take cash.`
      : todaysDrawer?.status === "CLOSED"
        ? "Today's drawer is closed — cash can't be taken until tomorrow's opens."
        : "Open today's cash drawer to take cash. Card, bKash and Nagad work without it.";

  // Line discounts first, then the whole-sale discount (৳ or % of what's left).
  const { priced, cartError } = useMemo((): { priced: PricedCart | null; cartError: string | null } => {
    const inputs = lines.map((l) => ({ key: l.key, qty: l.qty, unitPrice: Number(l.unitPrice) || 0, lineDiscount: Number(l.lineDiscount) || 0 }));
    try {
      const base = priceCart(inputs, 0);
      const raw = Number(cartDiscount) || 0;
      const amount = cartDiscountMode === "PERCENT" ? Math.round((base.totalPaisa * Math.min(100, raw)) / 100) / 100 : raw;
      return { priced: priceCart(inputs, amount), cartError: null };
    } catch (err) {
      return { priced: null, cartError: err instanceof CartError ? err.message : "Check the prices and discounts." };
    }
  }, [lines, cartDiscount, cartDiscountMode]);
  const pricedByKey = useMemo(() => (priced ? new Map(priced.lines.map((l) => [l.key, l])) : null), [priced]);
  const totalPaisa = priced?.totalPaisa ?? 0;
  const cartDiscountAmount = priced ? fromPaisa(priced.discountPaisa - lines.reduce((a, l) => a + toPaisa(Number(l.lineDiscount) || 0), 0)) : "0";

  const paidPaisa = tenders.reduce((a, t) => a + toPaisa(Number(t.amount) || 0), 0);
  const tendersValid = tenders.every((t) => toPaisa(Number(t.amount) || 0) > 0 && (t.method !== "CASH" || !t.tendered || toPaisa(Number(t.tendered) || 0) >= toPaisa(Number(t.amount) || 0)));
  const stockOk = lines.every((l) => l.qty <= l.available || (canSellOutOfStock && l.overrideReason.trim()));
  const canComplete = lines.length > 0 && priced !== null && paidPaisa === totalPaisa && tendersValid && stockOk && (cashAllowed || !tenders.some((t) => t.method === "CASH"));

  function addHit(hit: PosVariantHit) {
    setError(null);
    // Pure updater (it may run twice): two quick scans both land, and a
    // second scan of the same tag adds one to that line.
    const key = newLocalId();
    setLines((prev) => {
      const existing = prev.find((l) => l.variantId === hit.variantId);
      if (existing) return prev.map((l) => (l.key === existing.key ? { ...l, qty: Math.min(999, l.qty + 1), available: hit.available } : l));
      return [
        ...prev,
        {
          key,
          variantId: hit.variantId,
          productName: hit.productName,
          sku: hit.sku,
          sizeName: hit.sizeName,
          colorName: hit.colorName,
          colorHex: hit.colorHex,
          available: hit.available,
          listPrice: hit.price,
          qty: 1,
          unitPrice: String(Number(hit.price)),
          lineDiscount: "",
          overrideReason: "",
        },
      ];
    });
    setSelectedVariantId(hit.variantId);
  }

  function addTender(method: PosPaymentMethod) {
    const remaining = Math.max(0, totalPaisa - paidPaisa);
    if (remaining <= 0) return;
    const wallet = walletsForMethod(wallets, method)[0];
    setTenders((prev) => [...prev, { key: newLocalId(), method, amount: fromPaisa(remaining), tendered: "", walletId: method === "CASH" ? "" : (wallet?.id ?? ""), transactionId: "" }]);
  }

  function reset() {
    setLines([]);
    setSelectedVariantId(null);
    setCartDiscount("");
    setCartDiscountMode("AMOUNT");
    setCustomer(EMPTY_CUSTOMER);
    setTenders([]);
    setNote("");
    setError(null);
  }

  async function complete() {
    if (!canComplete || busy || !priced) return;
    setBusy(true);
    setError(null);
    try {
      const { sale } = await fetchJson<{ sale: PosSaleResult }>("/api/pos/sales", {
        method: "POST",
        body: JSON.stringify({
          items: lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitPrice: Number(l.unitPrice) || 0, lineDiscount: Number(l.lineDiscount) || 0, stockOverrideReason: l.overrideReason.trim() || null })),
          cartDiscount: Number(cartDiscountAmount),
          customer: customer.phone.trim() ? { phone: customer.phone.trim(), name: customer.name.trim() || null } : null,
          tenders: tenders.map((t) => ({
            method: t.method,
            amount: Number(t.amount),
            tendered: t.method === "CASH" && t.tendered ? Number(t.tendered) : null,
            walletId: t.method === "CASH" ? null : t.walletId || null,
            transactionId: t.transactionId.trim() || null,
          })),
          note: note.trim() || null,
        }),
      });
      setDone(sale);
      reset();
      refreshSide();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The sale didn't go through — nothing was charged. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function print(orderId: string) {
    setPrinting(true);
    try {
      await openInvoice(orderId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not open the invoice.");
    } finally {
      setPrinting(false);
    }
  }

  // Keyboard shortcuts. A scanner types into the focused search box, so the
  // shortcuts use function keys that scanners never send.
  const completeRef = useRef(complete);
  const addTenderRef = useRef(addTender);
  useEffect(() => {
    completeRef.current = complete;
    addTenderRef.current = addTender;
  });
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (done) return;
      if (e.key === "F2") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "F4") {
        e.preventDefault();
        phoneRef.current?.focus();
      } else if (e.key === "F8") {
        e.preventDefault();
        addTenderRef.current("CASH");
      } else if (e.key === "F9" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        void completeRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [done]);

  const itemCount = lines.reduce((a, l) => a + l.qty, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm">
        <div className="flex items-center gap-2">
          <Banknote className="size-4 text-muted-foreground" />
          {cashAllowed && todaysDrawer ? (
            <span>
              Cash drawer open · should hold <b className="tabular-nums">{formatBDT(todaysDrawer.expectedClose)}</b>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="size-4" />
              {cashBlockedReason}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {canExchange ? (
            <Button variant="outline" className="h-10" onClick={() => setExchangeOpen(true)}>
              <Repeat2 />
              Exchange
            </Button>
          ) : null}
          {canManageDrawer ? (
            <Button render={<Link href="/pos/drawer" />} nativeButton={false} variant="outline" className="h-10">
              {cashAllowed ? "Drawer" : "Open drawer"}
            </Button>
          ) : null}
        </div>
      </div>
      {exchangeOpen ? <CounterExchangeDialog onClose={() => setExchangeOpen(false)} onDone={refreshSide} /> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-3">
          <PosSearch ref={searchRef} onAdd={addHit} canSellOutOfStock={canSellOutOfStock} />
          <PosCart
            lines={lines}
            priced={pricedByKey}
            selectedVariantId={selectedVariantId}
            canSellOutOfStock={canSellOutOfStock}
            onSelect={setSelectedVariantId}
            onChange={(key, patch) => setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))}
            onRemove={(key) => setLines((prev) => prev.filter((l) => l.key !== key))}
          />
          {lines.length > 0 ? (
            <Button type="button" variant="ghost" className="self-start text-muted-foreground" onClick={reset}>
              Clear the sale
            </Button>
          ) : null}

          {recent.length > 0 ? (
            <section className="flex flex-col gap-1.5">
              <p className="text-sm font-medium text-muted-foreground">Today&apos;s sales</p>
              <ul className="flex flex-col divide-y rounded-xl border text-sm">
                {recent.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <Link href={`/orders/${s.id}`} className="font-mono font-medium hover:underline">
                        {s.orderNo}
                      </Link>
                      <span className="text-muted-foreground">
                        {" "}
                        · {formatDhakaDateTime(s.createdAt).split(", ").pop()} · {s.itemCount} item{s.itemCount === 1 ? "" : "s"} · {s.methods.map((m) => PAYMENT_METHOD_LABELS[m]).join(" + ")}
                        {s.customerName ? ` · ${s.customerName}` : ""}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="font-semibold tabular-nums">{formatBDT(s.total)}</span>
                      <Button type="button" variant="outline" size="icon-lg" aria-label={`Print receipt ${s.orderNo}`} onClick={() => openReceipt(s.id)}>
                        <Printer />
                      </Button>
                      <Button type="button" variant="ghost" size="icon-lg" aria-label={`A4 invoice ${s.orderNo}`} disabled={printing} onClick={() => void print(s.id)}>
                        <ReceiptText />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <div ref={checkoutRef} className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
          {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
          <PosCheckout
            subtotalPaisa={priced?.subtotalPaisa ?? 0}
            discountPaisa={priced?.discountPaisa ?? 0}
            totalPaisa={totalPaisa}
            cartError={cartError}
            cartDiscount={cartDiscount}
            cartDiscountMode={cartDiscountMode}
            onCartDiscount={(value, mode) => {
              setCartDiscount(value);
              setCartDiscountMode(mode);
            }}
            customer={customer}
            onCustomer={setCustomer}
            tenders={tenders}
            onAddTender={addTender}
            onChangeTender={(key, patch) => setTenders((prev) => prev.map((t) => (t.key === key ? { ...t, ...patch } : t)))}
            onRemoveTender={(key) => setTenders((prev) => prev.filter((t) => t.key !== key))}
            wallets={wallets}
            cashAllowed={cashAllowed}
            cashBlockedReason={cashAllowed ? null : cashBlockedReason}
            note={note}
            onNote={setNote}
            canComplete={canComplete}
            busy={busy}
            onComplete={() => void complete()}
            phoneRef={phoneRef}
          />
        </div>
      </div>

      {/* Phone / portrait tablet: the total and the way to pay stay in reach. */}
      <div className="sticky bottom-0 z-20 -mx-4 flex items-center justify-between gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6 lg:hidden">
        <div>
          <p className="text-xs text-muted-foreground">
            {itemCount} item{itemCount === 1 ? "" : "s"}
          </p>
          <p className="text-lg font-semibold tabular-nums">{formatBDT(fromPaisa(totalPaisa))}</p>
        </div>
        {canComplete ? (
          <Button className="h-12 px-6 text-base" disabled={busy} onClick={() => void complete()}>
            Complete sale
          </Button>
        ) : (
          <Button className="h-12 px-6 text-base" variant="outline" disabled={lines.length === 0} onClick={() => checkoutRef.current?.scrollIntoView({ behavior: "smooth" })}>
            Take payment
          </Button>
        )}
      </div>

      <Dialog open={done !== null} onOpenChange={(open) => !open && setDone(null)}>
        <DialogContent
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setDone(null);
            } else if ((e.key === "p" || e.key === "P") && done) {
              e.preventDefault();
              openReceipt(done.orderId);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="size-5 text-emerald-600" /> Sale complete
            </DialogTitle>
            <DialogDescription>
              <span className="font-mono">{done?.orderNo}</span>
              {done?.customerName ? ` · ${done.customerName}` : " · Walk-in customer"}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total paid</span>
              <span className="font-semibold tabular-nums">{done ? formatBDT(done.total) : ""}</span>
            </div>
            {done && Number(done.change) > 0 ? (
              <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
                <span>Give change</span>
                <span className="text-2xl font-semibold tabular-nums">{formatBDT(done.change)}</span>
              </div>
            ) : null}
            <Badge variant="outline" className="w-fit">
              Stock updated · status Completed
            </Badge>
          </div>
          <DialogFooter>
            <Button variant="ghost" className="h-12" disabled={printing || !done} onClick={() => done && void print(done.orderId)}>
              <ReceiptText />
              A4 invoice
            </Button>
            <Button variant="outline" className="h-12" disabled={!done} onClick={() => done && openReceipt(done.orderId)}>
              <Printer />
              Print receipt (P)
            </Button>
            <Button
              autoFocus
              className="h-12"
              onClick={() => {
                setDone(null);
                setTimeout(() => searchRef.current?.focus(), 0);
              }}
            >
              New sale (Enter)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
