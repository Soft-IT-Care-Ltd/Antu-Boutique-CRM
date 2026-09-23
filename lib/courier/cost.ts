import "server-only";

import type { DeliveryZone, Prisma } from "@prisma/client";

import { estimateCourierCost, type CostRate } from "@/lib/courier/constants";
import type { Db } from "@/lib/db/tx";
import { toNumber } from "@/lib/money";

export { estimateCourierCost };

export async function loadCostRates(db: Db, courierId: string): Promise<Map<DeliveryZone, CostRate>> {
  const rows = await db.courierCostRate.findMany({ where: { courierId } });
  return new Map(rows.map((r) => [r.zone, { zone: r.zone, baseRate: toNumber(r.baseRate), perKgRate: toNumber(r.perKgRate) }]));
}

/**
 * Parcel weight from the variants' optional unit weights. `complete` is
 * false when any shipped line has no weight on its variant — the dialog
 * says so rather than quietly under-estimating.
 */
export function orderWeightGrams(items: { qty: number; weightGrams: number | null }[]): { grams: number | null; complete: boolean } {
  let grams = 0;
  let any = false;
  let complete = true;
  for (const item of items) {
    if (item.qty <= 0) continue;
    if (item.weightGrams == null) {
      complete = false;
      continue;
    }
    any = true;
    grams += item.weightGrams * item.qty;
  }
  return { grams: any ? grams : null, complete: any && complete };
}

/**
 * The courier cost P&L uses for a shipment: the courier's actual charge when
 * it reported one, else our zone+weight estimate. For a RETURNED parcel the
 * return charge is posted as an expense by the condition check instead
 * (lib/returns/condition-check.ts) — P&L must not count it twice.
 */
export function effectiveCourierCost(shipment: { courierCostActual: Prisma.Decimal | null; courierCostEstimate: Prisma.Decimal | null }): number | null {
  if (shipment.courierCostActual !== null) return toNumber(shipment.courierCostActual);
  if (shipment.courierCostEstimate !== null) return toNumber(shipment.courierCostEstimate);
  return null;
}
