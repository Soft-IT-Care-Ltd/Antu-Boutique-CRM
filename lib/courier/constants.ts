// Courier constants — client-safe (no Prisma/server imports), shared by the
// Courier page, the order detail shipment card and the server services.

import type { DeliveryZoneValue } from "@/lib/orders/constants";

export const SHIPMENT_SUB_STATUS_VALUES = [
  "PENDING",
  "DELIVERY_APPROVAL_PENDING",
  "PARTIAL_DELIVERY_APPROVAL_PENDING",
  "RETURN_APPROVAL_PENDING",
] as const;
export type ShipmentSubStatusValue = (typeof SHIPMENT_SUB_STATUS_VALUES)[number];

export const SHIPMENT_SUB_STATUS_LABELS: Record<ShipmentSubStatusValue, string> = {
  PENDING: "At courier hub",
  DELIVERY_APPROVAL_PENDING: "Delivery approval pending",
  PARTIAL_DELIVERY_APPROVAL_PENDING: "Partial delivery approval pending",
  RETURN_APPROVAL_PENDING: "Return approval pending",
};

export const RETURN_INSPECTION_SOURCE_LABELS = {
  COURIER_RETURN: "Courier return",
  PARTIAL_DELIVERY: "Partial delivery",
  CUSTOMER_RETURN: "Customer return",
  EXCHANGE: "Exchange",
} as const;
export type ReturnInspectionSourceValue = keyof typeof RETURN_INSPECTION_SOURCE_LABELS;

export const RETURN_INSPECTION_STATUS_LABELS = {
  AWAITING_KEPT_ITEMS: "Mark kept items",
  PENDING: "Awaiting condition check",
  COMPLETED: "Checked",
} as const;
export type ReturnInspectionStatusValue = keyof typeof RETURN_INSPECTION_STATUS_LABELS;

/** The expense category the courier return charge posts to (created on first use). */
export const COURIER_RETURN_CHARGE_EXPENSE_CATEGORY = "Courier return charge";

// Steadfast's public tracking page. Gift Valy verified in production that
// the tracking frontend resolves /tl/{code} for a plain tracking_code.
export const STEADFAST_TRACKING_BASE = "https://steadfast.com.bd/tl/";

export function trackingUrlFromCode(trackingCode: string | null | undefined): string | null {
  const code = trackingCode?.trim();
  return code ? `${STEADFAST_TRACKING_BASE}${encodeURIComponent(code)}` : null;
}

/** Steadfast's bulk endpoint takes at most 500 orders per call. */
export const STEADFAST_MAX_BULK = 500;

export const COURIER_SHIPMENT_TABS = ["ready", "active", "attention", "delivered", "returned"] as const;
export type CourierShipmentTab = (typeof COURIER_SHIPMENT_TABS)[number];

export type CostRate = { zone: DeliveryZoneValue; baseRate: number; perKgRate: number };

/**
 * CORRECTIONS Courier §1 — our estimate of what the courier will charge US.
 * The base rate covers the first kilogram; every further started kilogram
 * adds the per-kg rate (how Steadfast actually bills). A missing weight is
 * treated as ≤ 1 kg. Null when the zone has no rate configured. The
 * courier's own delivery_charge (webhook) later overrides this for P&L.
 */
export function estimateCourierCost(rate: { baseRate: number; perKgRate: number } | null | undefined, weightGrams: number | null | undefined): number | null {
  if (!rate) return null;
  const kg = Math.max(1, Math.ceil(Math.max(weightGrams ?? 0, 0) / 1000));
  const cost = rate.baseRate + rate.perKgRate * (kg - 1);
  return Math.round(cost * 100) / 100;
}

export function formatWeight(grams: number | null | undefined): string {
  if (grams == null) return "—";
  return grams >= 1000 ? `${(grams / 1000).toFixed(grams % 1000 === 0 ? 0 : 2)} kg` : `${grams} g`;
}
