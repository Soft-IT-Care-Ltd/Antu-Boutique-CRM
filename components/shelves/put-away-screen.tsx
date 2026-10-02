"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { ArrowRight, Minus, Plus, X } from "lucide-react";

import { ScanBox, type ScanResult } from "@/components/scan/scan-box";
import { ItemRow } from "@/components/shelves/shelves-screen";
import { Button } from "@/components/ui/button";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { ShelfContentLine } from "@/lib/shelves/constants";

type Where = { unassigned: number; notOnShelf: number; shelves: { shelfId: string; code: string; qty: number }[] };
type Identify = { kind: "shelf"; shelf: { id: string; code: string }; message: string } | { kind: "item"; item: Omit<ShelfContentLine, "qty">; where: Where; message: string };
type PlaceResponse = { result: { shelfCode: string; results: { sku: string; placed: number; fromUnassigned: number; found: number; moved: { code: string; qty: number }[] }[] } };
type BasketLine = { item: Omit<ShelfContentLine, "qty">; where: Where; qty: number };

function describeWhere(w: Where): string {
  const parts = w.shelves.map((s) => `${s.code} ×${s.qty}`);
  if (w.unassigned > 0) parts.unshift(`Unassigned ×${w.unassigned}`);
  return parts.join(" · ") || "none here";
}

/**
 * C4b — CORRECTIONS.md item 20A, put-away and moving by scan:
 *   put away : scan the dresses, then the shelf label.
 *   move     : scan the shelf they're on, the dresses, then the new shelf.
 * Scanning a shelf with nothing in the basket picks the shelf to take from;
 * with dresses in it, it puts them there. Nothing else to type.
 */
export function PutAwayScreen({ location }: { location: { id: string; name: string } }) {
  const [from, setFromState] = useState<{ id: string; code: string } | null>(null);
  const [basket, setBasketState] = useState<BasketLine[]>([]);
  const [lastPlaced, setLastPlaced] = useState<string | null>(null);
  // A handheld scanner can fire the next tag before React re-renders: every
  // scan reads and writes the basket through these refs, never a stale render.
  const fromRef = useRef(from);
  const basketRef = useRef(basket);
  const setFrom = (next: { id: string; code: string } | null) => {
    fromRef.current = next;
    setFromState(next);
  };
  const setBasket = (update: (b: BasketLine[]) => BasketLine[]) => {
    basketRef.current = update(basketRef.current);
    setBasketState(basketRef.current);
  };

  const onScan = useCallback(
    async (code: string): Promise<ScanResult> => {
      const from = fromRef.current;
      const basket = basketRef.current;
      try {
        const { scan } = await fetchJson<{ scan: Identify }>(`/api/inventory/shelves/put-away`, { method: "POST", body: JSON.stringify({ action: "identify", locationId: location.id, code }) });
        if (scan.kind === "item") {
          const onFrom = from ? (scan.where.shelves.find((s) => s.shelfId === from.id)?.qty ?? 0) : null;
          const inBasket = basket.find((b) => b.item.variantId === scan.item.variantId)?.qty ?? 0;
          if (onFrom !== null && inBasket + 1 > onFrom) return { ok: false, message: `${scan.item.sku}: shelf ${from!.code} shows ${onFrom}. Scan the shelf it really came from — or clear the shelf to take it from wherever it is.` };
          setBasket((b) => {
            const found = b.find((l) => l.item.variantId === scan.item.variantId);
            return found ? b.map((l) => (l === found ? { ...l, qty: l.qty + 1, where: scan.where } : l)) : [...b, { item: scan.item, where: scan.where, qty: 1 }];
          });
          setLastPlaced(null);
          return { ok: true, message: `${scan.item.sku} · ${inBasket + 1} — now at ${describeWhere(scan.where)}` };
        }
        if (basket.length === 0) {
          if (from?.id === scan.shelf.id) return { ok: true, message: `Taking from ${scan.shelf.code} — scan the dresses` };
          setFrom(scan.shelf);
          return { ok: true, message: `Taking from shelf ${scan.shelf.code} — now scan the dresses, then the shelf they go to` };
        }
        const res = await fetchJson<PlaceResponse>(`/api/inventory/shelves/put-away`, {
          method: "POST",
          body: JSON.stringify({ action: "place", locationId: location.id, toShelfId: scan.shelf.id, fromShelfId: from?.id ?? null, items: basket.map((b) => ({ variantId: b.item.variantId, qty: b.qty })) }),
        });
        const units = res.result.results.reduce((a, r) => a + r.placed, 0);
        const moved = res.result.results.flatMap((r) => r.moved.map((m) => `${r.sku} from ${m.code}`));
        const found = res.result.results.reduce((a, r) => a + r.found, 0);
        const summary = `${units} on ${res.result.shelfCode}${moved.length ? ` · moved ${moved.join(", ")}` : ""}${found ? ` · ${found} found` : ""}`;
        setBasket(() => []);
        setFrom(null);
        setLastPlaced(summary);
        return { ok: true, message: summary };
      } catch (err) {
        return { ok: false, message: err instanceof ApiError ? err.message : "That scan didn't go through — scan it again." };
      }
    },
    [location.id],
  );

  const units = basket.reduce((a, b) => a + b.qty, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-lg font-medium">{location.name}</p>
        <Link href={`/inventory/shelves?location=${location.id}`} className="text-sm text-muted-foreground hover:underline">
          All shelves
        </Link>
      </div>

      <ol className="grid gap-2 text-sm sm:grid-cols-2">
        <li className="rounded-lg bg-muted/60 p-3">
          <b>Put away:</b> scan the dresses, then the shelf label.
        </li>
        <li className="rounded-lg bg-muted/60 p-3">
          <b>Move:</b> scan the shelf they&apos;re on, the dresses, then the new shelf.
        </li>
      </ol>

      <ScanBox onScan={onScan} placeholder="Scan a dress tag or a shelf label" hint="One scan, one dress. The shelf label puts everything scanned onto that shelf." />

      {from ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
          <span>
            Taking from shelf <b className="font-mono">{from.code}</b>
          </span>
          <Button variant="ghost" size="sm" onClick={() => setFrom(null)}>
            <X />
            Not from a shelf
          </Button>
        </div>
      ) : null}

      {basket.length === 0 ? (
        <div className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">{lastPlaced ? `Done — ${lastPlaced}. Scan the next dress.` : "Scan the first dress."}</div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              {units} dress{units === 1 ? "" : "es"} <ArrowRight className="size-4" /> scan the shelf they go on
            </p>
            <Button variant="ghost" size="sm" onClick={() => setBasket(() => [])}>
              Clear
            </Button>
          </div>
          <ul className="flex flex-col divide-y rounded-xl border">
            {basket.map((b) => (
              <ItemRow
                key={b.item.variantId}
                line={{ ...b.item, qty: b.qty }}
                sub={`Now: ${describeWhere(b.where)}`}
                right={
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="icon" aria-label={`One fewer ${b.item.sku}`} onClick={() => setBasket((all) => all.flatMap((l) => (l === b ? (l.qty > 1 ? [{ ...l, qty: l.qty - 1 }] : []) : [l])))}>
                      <Minus />
                    </Button>
                    <span className="w-8 text-center text-lg font-semibold tabular-nums">{b.qty}</span>
                    <Button variant="outline" size="icon" aria-label={`One more ${b.item.sku}`} onClick={() => setBasket((all) => all.map((l) => (l === b ? { ...l, qty: l.qty + 1 } : l)))}>
                      <Plus />
                    </Button>
                  </div>
                }
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
