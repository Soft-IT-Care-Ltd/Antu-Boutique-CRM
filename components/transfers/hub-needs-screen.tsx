"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CircleCheck, Loader2, PackageSearch, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { uploadUrl } from "@/lib/catalog/types";
import type { LocationOption } from "@/lib/locations/constants";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { HubNeedRow, HubNeeds } from "@/lib/transfers/hub-needs";

const key = (r: { orderId: string; variantId: string }) => `${r.orderId}:${r.variantId}`;

const DAY = 24 * 60 * 60 * 1000;
function waiting(iso: string) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
  return days <= 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
}

/**
 * C4 — CORRECTIONS.md item 3. The location's manager sees the waiting
 * online orders (oldest first) that need a dress from here, ticks what
 * they'll send, and one click opens a Draft transfer to the hub, pre-filled
 * and linked to those orders — then scans it out on the transfer screen.
 */
export function HubNeedsScreen({ locations, initialLocationId }: { locations: LocationOption[]; initialLocationId: string | null }) {
  const router = useRouter();
  const [locationId, setLocationId] = useState(initialLocationId);
  const [data, setData] = useState<HubNeeds | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Map<string, number>>(new Map());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const [reload, setReload] = useState(0);
  const refresh = () => {
    setLoading(true);
    setReload((n) => n + 1);
  };

  useEffect(() => {
    if (!locationId) return;
    let live = true;
    fetchJson<HubNeeds>(`/api/inventory/hub-needs?locationId=${encodeURIComponent(locationId)}`)
      .then((res) => {
        if (!live) return;
        setData(res);
        // Everything ticked by default — the usual answer is "send it all".
        setPicked(new Map(res.rows.map((r) => [key(r), r.qtyHere])));
        setError(null);
      })
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Couldn't load what the hub needs."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [locationId, reload]);

  const byOrder = useMemo(() => {
    const groups: { orderId: string; orderNo: string; customerName: string | null; createdAt: string; rows: HubNeedRow[] }[] = [];
    for (const r of data?.rows ?? []) {
      const last = groups[groups.length - 1];
      if (last && last.orderId === r.orderId) last.rows.push(r);
      else groups.push({ orderId: r.orderId, orderNo: r.orderNo, customerName: r.customerName, createdAt: r.orderCreatedAt, rows: [r] });
    }
    return groups;
  }, [data]);

  const units = [...picked.values()].reduce((a, n) => a + n, 0);
  const summary = new Map((data?.locations ?? []).map((l) => [l.id, l]));
  const allPicked = data !== null && data.rows.length > 0 && data.rows.every((r) => picked.has(key(r)));

  async function create() {
    if (!locationId || !data) return;
    setBusy(true);
    setError(null);
    try {
      const picks = data.rows.filter((r) => picked.has(key(r))).map((r) => ({ orderId: r.orderId, variantId: r.variantId, qty: picked.get(key(r))! }));
      const { transfer } = await fetchJson<{ transfer: { id: string } }>("/api/inventory/hub-needs", { method: "POST", body: JSON.stringify({ fromLocationId: locationId, picks }) });
      router.push(`/inventory/transfers/${transfer.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the transfer.");
      setBusy(false);
      refresh();
    }
  }

  if (locations.length === 0) {
    return <p className="rounded-xl border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">You aren&apos;t assigned to a location other than the packing hub — this screen is for the showroom and corner incharges.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0" role="tablist" aria-label="Location">
        {locations.map((l) => {
          const s = summary.get(l.id);
          return (
            <Button key={l.id} role="tab" aria-selected={locationId === l.id} size="sm" variant={locationId === l.id ? "nav" : "ghost"} className="shrink-0" onClick={() => (setLoading(true), setLocationId(l.id))}>
              {l.name}
              {s ? <span className={`rounded-full px-1.5 text-xs tabular-nums ${s.units > 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>{s.units}</span> : null}
            </Button>
          );
        })}
        <Button size="sm" variant="ghost" className="ml-auto shrink-0" onClick={refresh} disabled={loading} aria-label="Refresh">
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      {!data ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : data.rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-14 text-center">
          <CircleCheck className="size-8 text-emerald-600" />
          <p className="text-sm font-medium">Nothing needed from here</p>
          <p className="max-w-sm text-sm text-muted-foreground">Every waiting online order either has its dresses at {data.hub.name} already, has them on the way, or needs something this location doesn&apos;t hold.</p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox checked={allPicked} onCheckedChange={(on) => setPicked(on ? new Map(data.rows.map((r) => [key(r), r.qtyHere])) : new Map())} />
              Tick all
            </label>
            <span className="text-muted-foreground">
              {byOrder.length} order(s), oldest first
            </span>
          </div>
          <ul className="flex flex-col gap-3">
            {byOrder.map((o) => (
              <li key={o.orderId} className="rounded-xl border">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2 text-sm">
                  <Link href={`/orders/${o.orderId}`} className="font-mono font-semibold hover:underline">
                    {o.orderNo}
                  </Link>
                  <span className="text-muted-foreground">
                    {o.customerName ?? "—"} · waiting {waiting(o.createdAt)}
                  </span>
                </div>
                <ul className="divide-y">
                  {o.rows.map((r) => {
                    const k = key(r);
                    const on = picked.has(k);
                    return (
                      <li key={k} className="flex items-center gap-3 p-3">
                        <Checkbox
                          checked={on}
                          aria-label={`Send ${r.sku} for ${r.orderNo}`}
                          onCheckedChange={(v) =>
                            setPicked((prev) => {
                              const next = new Map(prev);
                              if (v) next.set(k, r.qtyHere);
                              else next.delete(k);
                              return next;
                            })
                          }
                        />
                        <div className="flex h-14 w-11 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                          {r.thumbPath ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={uploadUrl(r.thumbPath)} alt="" className="size-full object-cover" />
                          ) : (
                            <PackageSearch className="size-4 text-muted-foreground" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{r.productName}</p>
                          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                            <span className="size-3 shrink-0 rounded-full border" style={{ backgroundColor: r.colorHex }} />
                            <b className="text-foreground">{r.sizeName}</b> · {r.colorName} · <span className="font-mono text-xs">{r.sku}</span>
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Hub is short {r.shortAtHub} · {r.qtyHere} can go from here
                          </p>
                        </div>
                        {r.qtyHere > 1 && on ? (
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={r.qtyHere}
                            value={picked.get(k)}
                            aria-label={`How many ${r.sku} to send`}
                            className="h-9 w-16 text-center"
                            onChange={(e) => {
                              const n = Math.min(r.qtyHere, Math.max(1, Math.floor(Number(e.target.value) || 1)));
                              setPicked((prev) => new Map(prev).set(k, n));
                            }}
                          />
                        ) : (
                          <span className="w-16 text-center text-lg font-semibold tabular-nums">{on ? picked.get(k) : 0}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>

          <div className="sticky bottom-0 -mx-4 flex items-center justify-between gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:p-0">
            <span className="text-sm">
              <b className="tabular-nums">{units}</b> unit(s) ticked
            </span>
            <Button className="h-11" onClick={create} disabled={busy || units === 0}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              Create transfer to {data.hub.name} <ArrowRight />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
