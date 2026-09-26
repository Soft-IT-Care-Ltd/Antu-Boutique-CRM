"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { DELIVERY_ZONE_LABELS, DELIVERY_ZONE_VALUES, type DeliveryZoneValue } from "@/lib/orders/constants";
import { ApiError, fetchJson } from "@/lib/orders/client";

type Zone = { zone: DeliveryZoneValue; charge: string; codChargePercent: string; returnCharge: string };
type Courier = { id: string; name: string; contact: string | null; provider: string | null; isActive: boolean; orders: number; zones: (Zone & { configured: boolean })[] };
type Draft = { name: string; contact: string; isActive: boolean; zones: Zone[] };

const toDraft = (c: Courier | null): Draft => ({
  name: c?.name ?? "",
  contact: c?.contact ?? "",
  isActive: c?.isActive ?? true,
  zones: DELIVERY_ZONE_VALUES.map((zone) => {
    const z = c?.zones.find((x) => x.zone === zone);
    return { zone, charge: z?.charge ?? "0", codChargePercent: z?.codChargePercent ?? "0", returnCharge: z?.returnCharge ?? "0" };
  }),
});

// PRD §4.9 / §4.17 — couriers and what the customer pays per zone. The
// order form fills the delivery charge from here; an order keeps the charge
// it was placed with. What we pay the courier is on the Steadfast section.
export function CourierSettings() {
  const [couriers, setCouriers] = useState<Courier[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setCouriers((await fetchJson<{ couriers: Courier[] }>("/api/settings/couriers")).couriers);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load couriers.");
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount, no data-fetching lib in this project yet
    load();
  }, []);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!couriers) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="flex flex-col gap-4">
      {couriers.length === 0 && !adding ? <p className="py-6 text-center text-sm text-muted-foreground">No couriers yet.</p> : null}
      {couriers.map((c) => (
        <CourierCard key={c.id} courier={c} onSaved={load} />
      ))}
      {adding ? (
        <CourierCard
          courier={null}
          onSaved={async () => {
            setAdding(false);
            await load();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div>
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus />
            Add a courier
          </Button>
        </div>
      )}
    </div>
  );
}

function CourierCard({ courier, onSaved, onCancel }: { courier: Courier | null; onSaved: () => void | Promise<void>; onCancel?: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(courier));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const setZone = (zone: DeliveryZoneValue, key: keyof Omit<Zone, "zone">, value: string) => setDraft({ ...draft, zones: draft.zones.map((z) => (z.zone === zone ? { ...z, [key]: value } : z)) });

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const body = JSON.stringify({ name: draft.name, contact: draft.contact || null, isActive: draft.isActive, zones: draft.zones });
      await fetchJson(courier ? `/api/settings/couriers/${courier.id}` : "/api/settings/couriers", { method: courier ? "PATCH" : "POST", body });
      setMessage({ ok: true, text: "Saved — new orders use these charges." });
      await onSaved();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {courier ? courier.name : "New courier"}
          {courier?.provider ? <Badge variant="secondary">API</Badge> : null}
          {courier && !courier.isActive ? <Badge variant="outline">Off</Badge> : null}
        </CardTitle>
        <CardDescription>{courier ? `${courier.orders} order${courier.orders === 1 ? "" : "s"} so far. Couriers are switched off, never deleted.` : "Charges per zone are what the customer pays for delivery."}</CardDescription>
        <CardAction>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={draft.isActive} onCheckedChange={(on) => setDraft({ ...draft, isActive: on })} />
            Active
          </label>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`c-name-${courier?.id ?? "new"}`}>Name</Label>
            <Input id={`c-name-${courier?.id ?? "new"}`} value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`c-contact-${courier?.id ?? "new"}`}>Contact</Label>
            <Input id={`c-contact-${courier?.id ?? "new"}`} value={draft.contact} maxLength={120} placeholder="Hotline or account manager" onChange={(e) => setDraft({ ...draft, contact: e.target.value })} />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <div className="hidden grid-cols-[1fr_repeat(3,7rem)] gap-2 text-xs font-medium text-muted-foreground sm:grid">
            <span>Zone</span>
            <span>Delivery (৳)</span>
            <span>COD charge %</span>
            <span>Return (৳)</span>
          </div>
          {draft.zones.map((z) => (
            <div key={z.zone} className="grid grid-cols-3 items-end gap-2 rounded-md border p-2 sm:grid-cols-[1fr_repeat(3,7rem)] sm:items-center sm:border-0 sm:p-0">
              <span className="col-span-3 text-sm font-medium sm:col-span-1">{DELIVERY_ZONE_LABELS[z.zone]}</span>
              {(["charge", "codChargePercent", "returnCharge"] as const).map((key) => (
                <label key={key} className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground sm:sr-only">{key === "charge" ? "Delivery (৳)" : key === "codChargePercent" ? "COD %" : "Return (৳)"}</span>
                  <Input type="number" inputMode="decimal" min={0} step="0.01" value={z[key]} onChange={(e) => setZone(z.zone, key, e.target.value)} aria-label={`${DELIVERY_ZONE_LABELS[z.zone]} ${key}`} />
                </label>
              ))}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={save} disabled={saving || draft.name.trim().length < 2}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            {courier ? "Save" : "Add courier"}
          </Button>
          {onCancel ? (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          {message ? <p className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}
