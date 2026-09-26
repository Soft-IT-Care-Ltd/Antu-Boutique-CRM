"use client";

import { useEffect, useState } from "react";

import type { SelectableMethod } from "@/lib/payments/method-settings";

// The methods switched on in Settings → Payment methods, for the pickers.
// null until loaded (and if the request fails): pickers then show every
// method, and the server still refuses one that is switched off.
let cached: SelectableMethod[] | null = null;

export function useEnabledPaymentMethods(): SelectableMethod[] | null {
  const [enabled, setEnabled] = useState<SelectableMethod[] | null>(cached);
  useEffect(() => {
    let live = true;
    fetch("/api/settings/payment-methods")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { enabled?: SelectableMethod[] } | null) => {
        if (!live || !body?.enabled) return;
        cached = body.enabled;
        setEnabled(body.enabled);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return enabled;
}
