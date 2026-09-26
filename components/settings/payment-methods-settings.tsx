"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_VALUES } from "@/lib/orders/constants";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { SelectableMethod } from "@/lib/payments/method-settings";

// PRD §4.17 payment methods. Switching one off hides it from every payment
// picker and the server refuses new money by it; payments already recorded
// keep their method.
export function PaymentMethodsSettings({ initial }: { initial: SelectableMethod[] }) {
  const [enabled, setEnabled] = useState<SelectableMethod[]>(initial);
  const [saved, setSaved] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = enabled.length !== saved.length || enabled.some((m) => !saved.includes(m));

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const body = await fetchJson<{ enabled: SelectableMethod[] }>("/api/settings/payment-methods", { method: "PUT", body: JSON.stringify({ enabled }) });
      setSaved(body.enabled);
      setEnabled(body.enabled);
      setMessage({ ok: true, text: "Saved." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Payment methods</CardTitle>
        <CardDescription>What staff can pick when they take money — on orders, at the POS and for counter exchanges. Payments already recorded keep their method.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {PAYMENT_METHOD_VALUES.map((m) => (
            <label key={m} className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
              <Switch checked={enabled.includes(m)} onCheckedChange={(on) => setEnabled(on ? PAYMENT_METHOD_VALUES.filter((x) => x === m || enabled.includes(x)) : enabled.filter((x) => x !== m))} />
              {PAYMENT_METHOD_LABELS[m]}
            </label>
          ))}
        </div>
        {enabled.length === 0 ? <p className="text-xs text-destructive">Keep at least one method switched on.</p> : null}
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} disabled={saving || !dirty || enabled.length === 0}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
          {message ? <p className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}
