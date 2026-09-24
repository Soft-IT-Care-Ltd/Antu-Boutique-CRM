"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { MAX_STORE_CREDIT_EXPIRY_DAYS } from "@/lib/store-credit/constants";

// P3.2 — optional store credit expiry. Off by default: credit never lapses.
export function StoreCreditSettings({ initialDays }: { initialDays: number | null }) {
  const [enabled, setEnabled] = useState(initialDays !== null);
  const [days, setDays] = useState(String(initialDays ?? 365));
  const [saved, setSaved] = useState<number | null>(initialDays);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const value = enabled ? Number(days) : null;
  const invalid = enabled && (!Number.isInteger(value) || value! < 1 || value! > MAX_STORE_CREDIT_EXPIRY_DAYS);
  const dirty = value !== saved;

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const { expiryDays } = await fetchJson<{ expiryDays: number | null }>("/api/settings/store-credit", { method: "PUT", body: JSON.stringify({ expiryDays: value }) });
      setSaved(expiryDays);
      setMessage({ ok: true, text: expiryDays ? `Saved — credit added from now on expires after ${expiryDays} days.` : "Saved — store credit never expires." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Store credit</CardTitle>
        <CardDescription>
          Credit from exchanges and returns never expires unless you turn this on. A change applies to credit added from then on; credit already issued keeps its date.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Switch id="sc-expiry" checked={enabled} onCheckedChange={setEnabled} />
          <Label htmlFor="sc-expiry">Store credit expires</Label>
        </div>
        {enabled ? (
          <div className="flex items-center gap-2">
            <Label htmlFor="sc-days" className="text-sm font-normal">
              after
            </Label>
            <Input id="sc-days" type="number" inputMode="numeric" min={1} max={MAX_STORE_CREDIT_EXPIRY_DAYS} className="h-9 w-24" value={days} onChange={(e) => setDays(e.target.value)} />
            <span className="text-sm">days</span>
          </div>
        ) : null}
        {invalid ? <p className="text-xs text-destructive">Enter a whole number of days from 1 to {MAX_STORE_CREDIT_EXPIRY_DAYS}.</p> : null}
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} disabled={saving || invalid || !dirty}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
          {message ? <p className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}
