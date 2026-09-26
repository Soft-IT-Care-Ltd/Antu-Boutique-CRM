"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, fetchJson } from "@/lib/orders/client";

type Operations = { orderEditWindowMinutes: number; packingSlaHours: number; lowStockDefault: number };

// PRD §4.17 — order edit-window minutes, low-stock default threshold, and
// the packing SLA (PRD §4.8) the queue turns red by.
export function OperationsSettings({ initial }: { initial: Operations }) {
  const [form, setForm] = useState({ orderEditWindowMinutes: String(initial.orderEditWindowMinutes), packingSlaHours: String(initial.packingSlaHours), lowStockDefault: String(initial.lowStockDefault) });
  const [saved, setSaved] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = Number(form.orderEditWindowMinutes) !== saved.orderEditWindowMinutes || Number(form.packingSlaHours) !== saved.packingSlaHours || Number(form.lowStockDefault) !== saved.lowStockDefault;

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const { settings } = await fetchJson<{ settings: Operations }>("/api/settings/operations", { method: "PUT", body: JSON.stringify(form) });
      setSaved(settings);
      setMessage({ ok: true, text: "Saved." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  }

  const field = (key: keyof typeof form, id: string, label: string, unit: string, help: string, max: number, min = 1) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input id={id} type="number" inputMode="numeric" min={min} max={max} className="w-28" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
        <span className="text-sm text-muted-foreground">{unit}</span>
      </div>
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Orders &amp; stock</CardTitle>
        <CardDescription>Each takes effect straight away.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          {field("orderEditWindowMinutes", "ops-edit", "Order edit window", "minutes", "How long a Sales Executive may edit their order freely after placing it. After that, edits need a Team Leader's approval.", 1440)}
          {field("packingSlaHours", "ops-sla", "Packing SLA", "hours", "A confirmed order waiting longer than this turns red on the packing queue and counts as stuck.", 168)}
          {field("lowStockDefault", "ops-low", "Low-stock default", "units", "A variant without its own threshold is low when this many or fewer are available.", 1000, 0)}
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} disabled={saving || !dirty}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
          {message ? <p className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}
