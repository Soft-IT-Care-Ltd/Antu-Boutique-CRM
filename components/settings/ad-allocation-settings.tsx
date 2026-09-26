"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AD_ALLOCATION_LABELS, AD_ALLOCATION_VALUES, type AdAllocationMethod } from "@/lib/expenses/constants";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { cn } from "@/lib/utils";

const HELP: Record<AdAllocationMethod, string> = {
  EQUAL: "Every online order first confirmed that day carries the same share of the day's ad spend.",
  BY_VALUE: "A bigger order carries a bigger share, in proportion to its value.",
};

// PRD §4.12 / §4.17 ad-cost allocation — how a day's ad spend spreads over
// that day's confirmed online orders in per-order profit. Worked out on
// demand, so a change re-spreads past days too.
export function AdAllocationSettings({ initial }: { initial: AdAllocationMethod }) {
  const [method, setMethod] = useState(initial);
  const [saving, setSaving] = useState<AdAllocationMethod | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function choose(next: AdAllocationMethod) {
    if (next === method || saving) return;
    setSaving(next);
    setMessage(null);
    try {
      await fetchJson("/api/expenses/ad-spend/allocation", { method: "PUT", body: JSON.stringify({ method: next }) });
      setMethod(next);
      setMessage({ ok: true, text: "Saved — per-order profit uses it from now on, for past days too." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not save." });
    } finally {
      setSaving(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Ad-cost allocation</CardTitle>
        <CardDescription>How each day&apos;s ad spend is shared out over that day&apos;s orders when working out each order&apos;s profit. Monthly P&amp;L is not affected.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div role="radiogroup" aria-label="Ad-cost allocation" className="grid gap-2 sm:grid-cols-2">
          {AD_ALLOCATION_VALUES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={method === m}
              onClick={() => choose(m)}
              className={cn("flex flex-col items-start gap-1 rounded-md border p-3 text-left text-sm transition-colors", method === m ? "border-primary bg-primary/5" : "hover:bg-muted/60")}
            >
              <span className="flex items-center gap-2 font-medium">
                {saving === m ? <Loader2 className="size-4 animate-spin" /> : null}
                {AD_ALLOCATION_LABELS[m]}
              </span>
              <span className="text-xs text-muted-foreground">{HELP[m]}</span>
            </button>
          ))}
        </div>
        {message ? <p className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p> : null}
      </CardContent>
    </Card>
  );
}
