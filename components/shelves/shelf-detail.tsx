"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ClipboardList, Loader2 } from "lucide-react";

import { ItemRow } from "@/components/shelves/shelves-screen";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { ShelfContentLine } from "@/lib/shelves/constants";

export type ShelfDetailView = {
  id: string;
  code: string;
  note: string | null;
  isActive: boolean;
  lastCountedAt: string | null;
  location: { id: string; name: string };
  contents: ShelfContentLine[];
  units: number;
  openCountId: string | null;
  history: { id: string; kind: string; qty: number; direction: "in" | "out"; otherShelf: string | null; sku: string; productName: string; actorName: string | null; createdAt: string }[];
  can: { count: boolean; manage: boolean };
};

const KIND_LABEL: Record<string, (h: ShelfDetailView["history"][number]) => string> = {
  PUT_AWAY: () => "Put away",
  MOVE: (h) => (h.direction === "in" ? `Moved in from ${h.otherShelf}` : `Moved to ${h.otherShelf}`),
  OUT: () => "Left the location (sold, packed or sent)",
  MISSING: () => "Not found in a shelf count",
  FOUND: () => "Found and put here",
};

/** C4b — one shelf: what the system says is on it, counting it, and its history. */
export function ShelfDetail({ shelf }: { shelf: ShelfDetailView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startCount() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchJson<{ count: { id: string } }>(`/api/inventory/shelves/counts`, { method: "POST", body: JSON.stringify({ shelfId: shelf.id }) });
      router.push(`/inventory/shelves/counts/${res.count.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the count — try again.");
      setBusy(false);
    }
  }

  async function toggleActive() {
    setBusy(true);
    setError(null);
    try {
      await fetchJson(`/api/inventory/shelves/${shelf.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !shelf.isActive }) });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't go through — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-xl border p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold">{shelf.code}</h1>
            {!shelf.isActive ? <Badge variant="outline">Switched off</Badge> : null}
          </div>
          <Link href={`/inventory/shelves?location=${shelf.location.id}`} className="text-sm text-muted-foreground hover:underline">
            All shelves
          </Link>
        </div>
        <p className="text-base">
          {shelf.location.name} · <b>{shelf.units}</b> pcs
        </p>
        {shelf.note ? <p className="text-sm text-muted-foreground">{shelf.note}</p> : null}
        <p className="text-sm text-muted-foreground">{shelf.lastCountedAt ? `Last counted ${formatDhakaDateTime(shelf.lastCountedAt)}` : "Never counted"}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          {shelf.openCountId ? (
            <Button className="h-11" render={<Link href={`/inventory/shelves/counts/${shelf.openCountId}`} />} nativeButton={false}>
              <ClipboardList />
              Continue the count
            </Button>
          ) : shelf.can.count ? (
            <Button className="h-11" disabled={busy} onClick={startCount}>
              {busy ? <Loader2 className="animate-spin" /> : <ClipboardList />}
              Count this shelf
            </Button>
          ) : null}
          {shelf.can.manage ? (
            <Button variant="outline" className="h-11" disabled={busy} onClick={toggleActive}>
              {shelf.isActive ? "Switch off" : "Switch on"}
            </Button>
          ) : null}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>

      <h2 className="text-sm font-medium text-muted-foreground">On this shelf</h2>
      {shelf.contents.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">Nothing on this shelf.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border">
          {shelf.contents.map((l) => (
            <ItemRow key={l.variantId} line={l} right={<span className="text-xl font-semibold tabular-nums">{l.qty}</span>} />
          ))}
        </ul>
      )}

      {shelf.history.length > 0 ? (
        <>
          <h2 className="text-sm font-medium text-muted-foreground">Recent</h2>
          <ul className="flex flex-col divide-y rounded-xl border text-sm">
            {shelf.history.map((h) => (
              <li key={h.id} className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="truncate">
                    <span className="font-mono text-xs">{h.sku}</span> {h.productName}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {(KIND_LABEL[h.kind] ?? (() => h.kind))(h)} · {formatDhakaDateTime(h.createdAt)}
                    {h.actorName ? ` · ${h.actorName}` : ""}
                  </p>
                </div>
                <span className={h.direction === "in" ? "font-semibold text-emerald-700 dark:text-emerald-400" : "font-semibold text-destructive"}>
                  {h.direction === "in" ? "+" : "−"}
                  {h.qty}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
