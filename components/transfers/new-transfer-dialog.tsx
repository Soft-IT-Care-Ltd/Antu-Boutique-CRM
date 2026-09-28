"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { LocationOption } from "@/lib/locations/constants";
import { ApiError, fetchJson } from "@/lib/orders/client";

/** Opens a Draft transfer from one of the person's locations; the scanning happens on its own screen. */
export function NewTransferDialog({ sendFrom, locations }: { sendFrom: LocationOption[]; locations: LocationOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fromId, setFromId] = useState(sendFrom[0]?.id ?? "");
  const hub = locations.find((l) => l.isPackingHub);
  const [toId, setToId] = useState(hub && hub.id !== sendFrom[0]?.id ? hub.id : "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = (id: string) => locations.find((l) => l.id === id)?.name ?? "Pick a location";

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { transfer } = await fetchJson<{ transfer: { id: string } }>("/api/inventory/transfers", { method: "POST", body: JSON.stringify({ fromLocationId: fromId, toLocationId: toId, note: note || null }) });
      router.push(`/inventory/transfers/${transfer.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the transfer.");
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={sendFrom.length === 0} title={sendFrom.length === 0 ? "You aren't assigned to any location" : undefined}>
        <Plus /> New transfer
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New transfer</DialogTitle>
            <DialogDescription>Pick where it goes, then scan every dress as you pack it.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
            <div className="flex flex-col gap-1.5">
              <Label>From</Label>
              <Select value={fromId} onValueChange={(v) => setFromId(v as string)}>
                <SelectTrigger className="w-full">
                  <SelectValue>{(v: string) => name(v)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {sendFrom.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <ArrowRight className="mx-auto hidden size-4 text-muted-foreground sm:mb-2.5 sm:block" />
            <div className="flex flex-col gap-1.5">
              <Label>To</Label>
              <Select value={toId} onValueChange={(v) => setToId(v as string)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick a location">{(v: string) => name(v)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {locations
                    .filter((l) => l.id !== fromId)
                    .map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.name}
                        {l.isPackingHub ? " (packing hub)" : ""}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="transfer-note">Note</Label>
            <Textarea id="transfer-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional — e.g. who is carrying it" />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button onClick={create} disabled={busy || !fromId || !toId || fromId === toId}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              Start scanning
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
