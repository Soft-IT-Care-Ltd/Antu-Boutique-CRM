"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { CircleAlert, Loader2, PackageSearch, Plus, Printer, ScanBarcode, Search, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { uploadUrl } from "@/lib/catalog/types";
import { DEFAULT_LABEL_STOCK_ID, LABEL_STOCKS, ROLL_PRINTER_DPIS } from "@/lib/catalog/price-tag-layout";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { compareShelfCodes, type ShelfContentLine, type ShelfLocationView, type ShelfMissView } from "@/lib/shelves/constants";
import { cn } from "@/lib/utils";

/**
 * C4b — CORRECTIONS.md item 20A. One location's shelves: every shelf with
 * what it holds, what's still Unassigned (waiting to be put away), and
 * what a shelf count didn't find on its shelf. Phone-first.
 */
export function ShelvesScreen({ view, locations }: { view: ShelfLocationView; locations: { id: string; name: string }[] }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [picking, setPicking] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [writingOff, setWritingOff] = useState<ShelfMissView | null>(null);

  const shelves = useMemo(() => {
    const term = q.trim().toUpperCase();
    return term ? view.shelves.filter((s) => s.code.includes(term) || (s.note ?? "").toUpperCase().includes(term)) : view.shelves;
  }, [q, view.shelves]);
  const t = view.totals;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {locations.length > 1 ? (
          <Select value={view.location.id} onValueChange={(v) => router.push(`/inventory/shelves?location=${v as string}`)}>
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue>{(v: string) => locations.find((l) => l.id === v)?.name ?? "Location"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {locations.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-lg font-medium">{view.location.name}</p>
        )}
        <div className="flex flex-wrap gap-2">
          {view.can.putAway ? (
            <Button className="h-11" render={<Link href={`/inventory/shelves/put-away?location=${view.location.id}`} />} nativeButton={false}>
              <ScanBarcode />
              Put away / move
            </Button>
          ) : null}
          {view.can.manage ? (
            <Button variant="outline" className="h-11" onClick={() => setAdding(true)}>
              <Plus />
              Add shelves
            </Button>
          ) : null}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
        {(
          [
            ["In stock here", t.stock, ""],
            ["On shelves", t.shelved, ""],
            ["Unassigned", t.unassigned, t.unassigned > 0 ? "text-amber-700 dark:text-amber-400" : ""],
            ["Not on its shelf", t.notOnShelf, t.notOnShelf > 0 ? "text-destructive" : ""],
          ] as const
        ).map(([label, value, tone]) => (
          <div key={label} className="rounded-lg bg-muted/60 px-1 py-2">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className={cn("text-lg font-semibold tabular-nums", tone)}>{value}</dd>
          </div>
        ))}
      </dl>

      <Tabs defaultValue="shelves">
        <TabsList>
          <TabsTrigger value="shelves">Shelves ({view.shelves.filter((s) => s.isActive).length})</TabsTrigger>
          <TabsTrigger value="unassigned">Unassigned ({t.unassigned})</TabsTrigger>
          <TabsTrigger value="missing">Not on its shelf ({t.notOnShelf})</TabsTrigger>
        </TabsList>

        <TabsContent value="shelves" className="flex flex-col gap-3 pt-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a shelf — A-2, B-1-3…" className="h-10 pl-9" />
            </div>
            {view.can.manage ? (
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setPicking(picking.size === shelves.length ? new Set() : new Set(shelves.filter((s) => s.isActive).map((s) => s.id)))}>
                  {picking.size > 0 && picking.size === shelves.length ? "Clear" : "Select all"}
                </Button>
                <Button variant="outline" disabled={picking.size === 0} onClick={() => setPrinting(true)}>
                  <Printer />
                  Labels{picking.size ? ` (${picking.size})` : ""}
                </Button>
              </div>
            ) : null}
          </div>
          {shelves.length === 0 ? (
            <Empty title={view.shelves.length === 0 ? "No shelves yet" : "No shelf matches"} text={view.shelves.length === 0 ? (view.can.manage ? "Add the racks and boxes, print their labels and stick them on." : "A manager adds the shelves and prints their labels.") : "Try another code."} />
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {shelves.map((s) => (
                <li key={s.id} className={cn("flex items-center gap-3 rounded-xl border p-3", !s.isActive && "opacity-60")}>
                  {view.can.manage && s.isActive ? (
                    <input
                      type="checkbox"
                      className="size-5 accent-primary"
                      aria-label={`Select ${s.code} for labels`}
                      checked={picking.has(s.id)}
                      onChange={(e) => {
                        const next = new Set(picking);
                        if (e.target.checked) next.add(s.id);
                        else next.delete(s.id);
                        setPicking(next);
                      }}
                    />
                  ) : null}
                  <Link href={`/inventory/shelves/${s.id}`} className="flex min-w-0 flex-1 items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-mono text-lg font-semibold">{s.code}</p>
                      <p className="truncate text-xs text-muted-foreground">{s.note ?? (s.lastCountedAt ? `Counted ${formatDhakaDateTime(s.lastCountedAt)}` : "Never counted")}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-lg font-semibold tabular-nums">
                        {s.units}
                        <span className="text-xs font-normal text-muted-foreground"> pcs · {s.items} items</span>
                      </span>
                      {s.openCountId ? <Badge variant="secondary">Counting</Badge> : !s.isActive ? <Badge variant="outline">Off</Badge> : null}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="unassigned" className="flex flex-col gap-3 pt-4">
          <p className="text-sm text-muted-foreground">Stock here that isn&apos;t on any shelf yet — arrivals waiting to be put away, and units a shelf count didn&apos;t find.</p>
          {view.unassigned.length === 0 ? (
            <Empty title="Everything is on a shelf" text="New stock lands here until someone scans it onto a shelf." />
          ) : (
            <ul className="flex flex-col divide-y rounded-xl border">
              {view.unassigned.map((l) => (
                <ItemRow key={l.variantId} line={l} right={<Qty qty={l.qty} note={l.notOnShelf ? `${l.notOnShelf} not on its shelf` : null} />} />
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="missing" className="flex flex-col gap-3 pt-4">
          <p className="text-sm text-muted-foreground">A shelf count didn&apos;t find these on their shelf. They&apos;re still in stock — maybe on another shelf. Scanning one onto a shelf finds it; a location count settles them; a manager can write them off.</p>
          {view.misses.length === 0 ? (
            <Empty title="Nothing missing from its shelf" text="Shelf counts found everything where the system said." />
          ) : (
            <ul className="flex flex-col divide-y rounded-xl border">
              {view.misses.map((m) => (
                <ItemRow
                  key={m.id}
                  line={{ ...m.item, qty: m.qty }}
                  sub={`Missing from ${m.shelfCode} · ${formatDhakaDateTime(m.createdAt)}`}
                  right={
                    <div className="flex flex-col items-end gap-1">
                      <Qty qty={m.qty} />
                      {view.can.writeOff ? (
                        <Button size="sm" variant="outline" onClick={() => setWritingOff(m)}>
                          Write off
                        </Button>
                      ) : null}
                    </div>
                  }
                />
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>

      <AddShelvesDialog open={adding} onOpenChange={setAdding} locationId={view.location.id} onDone={() => router.refresh()} />
      <LabelsDialog open={printing} onOpenChange={setPrinting} shelfIds={[...picking]} codes={view.shelves.filter((s) => picking.has(s.id)).map((s) => s.code).sort(compareShelfCodes)} />
      <WriteOffDialog miss={writingOff} onClose={() => setWritingOff(null)} onDone={() => router.refresh()} />
    </div>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-10 text-center">
      <PackageSearch className="size-8 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

function Qty({ qty, note }: { qty: number; note?: string | null }) {
  return (
    <div className="flex flex-col items-end">
      <span className="text-xl font-semibold tabular-nums">{qty}</span>
      {note ? <span className="text-xs text-destructive">{note}</span> : null}
    </div>
  );
}

export function ItemRow({ line: l, sub, right }: { line: ShelfContentLine; sub?: string; right: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 p-3">
      <div className="flex h-14 w-11 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
        {l.thumbPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={uploadUrl(l.thumbPath)} alt="" className="size-full object-cover" />
        ) : (
          <PackageSearch className="size-4 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{l.productName}</p>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <span className="size-3 shrink-0 rounded-full border" style={{ backgroundColor: l.colorHex }} />
          <b className="text-foreground">{l.sizeName}</b> · {l.colorName} · <span className="font-mono text-xs">{l.sku}</span>
        </p>
        {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
      </div>
      <div className="shrink-0">{right}</div>
    </li>
  );
}

function AddShelvesDialog({ open, onOpenChange, locationId, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; locationId: string; onDone: () => void }) {
  const [mode, setMode] = useState<"rack" | "codes">("rack");
  const [rack, setRack] = useState("A");
  const [shelfCount, setShelfCount] = useState(4);
  const [boxes, setBoxes] = useState(3);
  const [codes, setCodes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = mode === "rack" ? (boxes > 0 ? `${rack || "A"}-1-1 … ${rack || "A"}-${shelfCount}-${boxes} (${shelfCount * boxes} shelves)` : `${rack || "A"}-1 … ${rack || "A"}-${shelfCount} (${shelfCount} shelves)`) : null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body =
        mode === "rack"
          ? { locationId, rack, shelves: shelfCount, boxes }
          : {
              locationId,
              codes: codes
                .split(/[\s,]+/)
                .map((c) => c.trim())
                .filter(Boolean),
            };
      await fetchJson(`/api/inventory/shelves`, { method: "POST", body: JSON.stringify(body) });
      onOpenChange(false);
      setCodes("");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add the shelves — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add shelves</DialogTitle>
          <DialogDescription>A shelf code is rack-shelf-box, like A-2-3. Print the labels afterwards and stick each on its rack or box.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {(["rack", "codes"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={cn("rounded-lg border p-2 text-sm", mode === m ? "border-primary bg-primary/5 font-medium" : "")}>
              {m === "rack" ? "A whole rack" : "Type the codes"}
            </button>
          ))}
        </div>
        {mode === "rack" ? (
          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rack">Rack</Label>
              <Input id="rack" value={rack} maxLength={4} onChange={(e) => setRack(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} className="font-mono" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="shelves">Shelves</Label>
              <Input id="shelves" type="number" inputMode="numeric" min={1} max={20} value={shelfCount} onChange={(e) => setShelfCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="boxes">Boxes each</Label>
              <Input id="boxes" type="number" inputMode="numeric" min={0} max={20} value={boxes} onChange={(e) => setBoxes(Math.max(0, Math.min(20, Number(e.target.value) || 0)))} />
            </div>
            <p className="col-span-3 text-sm text-muted-foreground">{preview}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="codes">Shelf codes</Label>
            <Textarea id="codes" value={codes} onChange={(e) => setCodes(e.target.value)} placeholder="A-1-1, A-1-2, B-1" className="font-mono" rows={4} />
          </div>
        )}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Back
          </Button>
          <Button disabled={busy || (mode === "rack" ? !rack : !codes.trim())} onClick={save}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            Add shelves
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LabelsDialog({ open, onOpenChange, shelfIds, codes }: { open: boolean; onOpenChange: (o: boolean) => void; shelfIds: string[]; codes: string[] }) {
  const [stockId, setStockId] = useState(DEFAULT_LABEL_STOCK_ID);
  const [dpi, setDpi] = useState<number>(203);
  const [copies, setCopies] = useState(1);
  const formRef = useRef<HTMLFormElement>(null);
  const payloadRef = useRef<HTMLInputElement>(null);
  const stock = LABEL_STOCKS.find((s) => s.id === stockId)!;

  function print() {
    if (!formRef.current || !payloadRef.current) return;
    payloadRef.current.value = JSON.stringify({ shelfIds, copies, stockId, dpi, startAt: 1 });
    // A real form post into a new tab, like the price tags: opens on every browser, iPad Safari included.
    formRef.current.submit();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Print shelf labels</DialogTitle>
          <DialogDescription>
            {codes.length} shelf label{codes.length === 1 ? "" : "s"}: <span className="font-mono">{codes.slice(0, 8).join(", ")}{codes.length > 8 ? " …" : ""}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label>Label</Label>
          <Select value={stockId} onValueChange={(v) => setStockId(v as string)}>
            <SelectTrigger className="w-full">
              <SelectValue>{(v: string) => LABEL_STOCKS.find((s) => s.id === v)?.label ?? "Label"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {LABEL_STOCKS.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {stock.kind === "ROLL" ? (
            <div className="flex flex-col gap-1.5">
              <Label>Printer</Label>
              <Select value={String(dpi)} onValueChange={(v) => setDpi(Number(v))}>
                <SelectTrigger className="w-full">
                  <SelectValue>{(v: string) => `${v} dpi`}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {ROLL_PRINTER_DPIS.map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {d} dpi
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="copies">Copies of each</Label>
            <Input id="copies" type="number" inputMode="numeric" min={1} max={10} value={copies} onChange={(e) => setCopies(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} />
          </div>
        </div>
        <form ref={formRef} method="post" action="/api/inventory/shelves/labels" target="_blank" className="hidden">
          <input ref={payloadRef} type="hidden" name="payload" />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Back
          </Button>
          <Button disabled={shelfIds.length === 0} onClick={print}>
            <Printer />
            Print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WriteOffDialog({ miss, onClose, onDone }: { miss: ShelfMissView | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!miss) return;
    setBusy(true);
    setError(null);
    try {
      await fetchJson(`/api/inventory/shelves/misses/${miss.id}`, { method: "POST", body: JSON.stringify({ reason }) });
      setReason("");
      onClose();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't write it off — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={miss !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Write off {miss?.qty} × {miss?.item.sku}?</DialogTitle>
          <DialogDescription>It leaves this location&apos;s stock and is booked at cost under &quot;Stock shortage&quot;. Only do this when it can&apos;t be found anywhere — a location count settles it too.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wo-reason">Why</Label>
          <Textarea id="wo-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Searched every rack — not found" rows={3} />
        </div>
        {error ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Back
          </Button>
          <Button variant="destructive" disabled={busy || reason.trim().length < 3} onClick={submit}>
            {busy ? <Loader2 className="animate-spin" /> : <TriangleAlert />}
            Write off
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
