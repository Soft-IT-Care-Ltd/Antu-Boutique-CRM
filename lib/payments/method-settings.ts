// PRD §4.17 "payment methods" — which of the §4.10 methods staff can pick
// when they record money (PRD §9 default: all six). Client- and server-safe;
// the server reads/enforces it in lib/payments/methods.ts.
//
// Only what a person types in is switched: courier COD, exchange credit and
// store credit are the system's own and are never listed here.

import { PAYMENT_METHOD_VALUES, type PaymentMethodValue } from "@/lib/orders/constants";

export const PAYMENT_METHODS_SETTING_KEY = "payment_methods_enabled";

export type SelectableMethod = (typeof PAYMENT_METHOD_VALUES)[number];

export function parseEnabledPaymentMethods(raw: string | null): SelectableMethod[] {
  if (!raw) return [...PAYMENT_METHOD_VALUES];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [...PAYMENT_METHOD_VALUES];
    const enabled = PAYMENT_METHOD_VALUES.filter((m) => value.includes(m));
    return enabled.length > 0 ? enabled : [...PAYMENT_METHOD_VALUES];
  } catch {
    return [...PAYMENT_METHOD_VALUES];
  }
}

/** Keeps `methods` in their usual order, minus any switched off. Methods outside the switchable six pass through. */
export function filterEnabledMethods<M extends PaymentMethodValue>(methods: readonly M[], enabled: readonly SelectableMethod[] | null): M[] {
  if (!enabled) return [...methods];
  return methods.filter((m) => !(PAYMENT_METHOD_VALUES as readonly string[]).includes(m) || (enabled as readonly string[]).includes(m));
}
