"use client";

import { useEffect, useState } from "react";
import { Loader2, MapPin, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { LOCATION_TYPE_LABELS, LOCATION_TYPES, type LocationTypeValue } from "@/lib/locations/constants";
import { ApiError, fetchJson } from "@/lib/orders/client";

type Person = { id: string; name: string; roleLabel: string };
type Row = {
  id: string;
  name: string;
  type: LocationTypeValue;
  address: string | null;
  isPackingHub: boolean;
  hasPos: boolean;
  isActive: boolean;
  units: number;
  managers: Person[];
};
type Draft = {
  name: string;
  type: LocationTypeValue;
  address: string;
  isPackingHub: boolean;
  hasPos: boolean;
  isActive: boolean;
  userIds: string[];
};

const toDraft = (r: Row | null): Draft => ({
  name: r?.name ?? "",
  type: r?.type ?? "WAREHOUSE",
  address: r?.address ?? "",
  isPackingHub: r?.isPackingHub ?? false,
  hasPos: r?.hasPos ?? false,
  isActive: r?.isActive ?? true,
  userIds: r?.managers.map((m) => m.id) ?? [],
});

// CORRECTIONS.md item 2 — where stock lives, and who manages each place.
// Managers (incharges) act for their locations' stock — adjustments,
// purchases received, and (C4) transfers and counts. Admin and Manager act
// for every location through their role.
export function LocationsSettings() {
  const [data, setData] = useState<{
    locations: Row[];
    staff: Person[];
  } | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setData(await fetchJson<{ locations: Row[]; staff: Person[] }>("/api/settings/locations"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load locations.");
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount, no data-fetching lib in this project yet
    load();
  }, []);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="flex flex-col gap-4">
      {data.locations.map((l) => (
        <LocationCard key={l.id} row={l} staff={data.staff} onSaved={load} />
      ))}
      {adding ? (
        <LocationCard
          row={null}
          staff={data.staff}
          onSaved={() => {
            setAdding(false);
            void load();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <Button variant="outline" className="self-start" onClick={() => setAdding(true)}>
          <Plus />
          Add a location
        </Button>
      )}
    </div>
  );
}

function LocationCard({ row, staff, onSaved, onCancel }: { row: Row | null; staff: Person[]; onSaved: () => void; onCancel?: () => void }) {
  const [editing, setEditing] = useState(row === null);
  const [draft, setDraft] = useState<Draft>(toDraft(row));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await fetchJson(row ? `/api/settings/locations/${row.id}` : "/api/settings/locations", {
        method: row ? "PUT" : "POST",
        body: JSON.stringify({
          ...draft,
          address: draft.address.trim() || null,
        }),
      });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  if (!editing && row) {
    return (
      <Card size="sm" className={row.isActive ? undefined : "opacity-60"}>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <MapPin className="size-4 text-muted-foreground" />
            {row.name}
            {row.isPackingHub ? <Badge>Packing hub</Badge> : null}
            {row.hasPos ? <Badge variant="secondary">POS</Badge> : null}
            {!row.isActive ? <Badge variant="outline">Switched off</Badge> : null}
          </CardTitle>
          <CardDescription>
            {LOCATION_TYPE_LABELS[row.type]} · {row.units} unit(s) held
            {row.address ? ` · ${row.address}` : ""}
          </CardDescription>
          <CardAction>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDraft(toDraft(row));
                setEditing(true);
              }}
            >
              Edit
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="text-sm">
          <span className="text-muted-foreground">Managers: </span>
          {row.managers.length === 0 ? <span className="text-muted-foreground">none yet — only Admin and Manager act here</span> : row.managers.map((m) => m.name).join(", ")}
        </CardContent>
      </Card>
    );
  }

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{row ? `Edit ${row.name}` : "New location"}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`loc-name-${row?.id ?? "new"}`}>Name</Label>
            <Input id={`loc-name-${row?.id ?? "new"}`} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Type</Label>
            <Select value={draft.type} onValueChange={(v) => set({ type: v as LocationTypeValue })}>
              <SelectTrigger className="w-full">
                <SelectValue>{(value: LocationTypeValue) => LOCATION_TYPE_LABELS[value]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {LOCATION_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {LOCATION_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`loc-address-${row?.id ?? "new"}`}>Address</Label>
          <Input id={`loc-address-${row?.id ?? "new"}`} value={draft.address} onChange={(e) => set({ address: e.target.value })} />
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
            <span>
              Packing hub
              <span className="block text-xs text-muted-foreground">Online orders are packed here</span>
            </span>
            <Switch checked={draft.isPackingHub} onCheckedChange={(v) => set({ isPackingHub: v, isActive: v ? true : draft.isActive })} disabled={row?.isPackingHub} />
          </label>
          <label className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
            <span>
              Has POS
              <span className="block text-xs text-muted-foreground">The showroom counter sells from here</span>
            </span>
            <Switch checked={draft.hasPos} onCheckedChange={(v) => set({ hasPos: v })} />
          </label>
          <label className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
            <span>Active</span>
            <Switch checked={draft.isActive} onCheckedChange={(v) => set({ isActive: v })} disabled={draft.isPackingHub} />
          </label>
        </div>
        {row?.isPackingHub ? <p className="text-xs text-muted-foreground">To move the packing hub, switch it on for another location.</p> : null}
        <div className="flex flex-col gap-1.5">
          <Label>Managers / incharges</Label>
          <div className="grid max-h-56 gap-1 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2">
            {staff.map((p) => (
              <label key={p.id} className="flex min-h-9 items-center gap-2 rounded px-1.5 text-sm hover:bg-muted/60">
                <Checkbox
                  checked={draft.userIds.includes(p.id)}
                  onCheckedChange={(checked) =>
                    set({
                      userIds: checked ? [...draft.userIds, p.id] : draft.userIds.filter((id) => id !== p.id),
                    })
                  }
                />
                <span className="min-w-0 truncate">
                  {p.name} <span className="text-xs text-muted-foreground">· {p.roleLabel}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => (row ? setEditing(false) : onCancel?.())}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || draft.name.trim().length < 2}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
