import { can } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/types";

// CLAUDE.md rule 5: cost/profit/margin/purchase price are stripped at the
// API layer for any role without product.cost.view — the JSON response
// must not contain the field, not just hide it in the UI. Every route that
// serializes a product, variant, purchase or order-with-cost MUST pipe its
// response body through stripCostFieldsForUser (or stripCostFields, if it
// already knows whether the caller has cost access).

const COST_FIELD_NAMES = new Set([
  "cost",
  "costPrice",
  "unitCost",
  "unitCostSnapshot",
  "purchasePrice",
  "purchaseCost",
  "weightedAvgCost",
  "totalCost",
  "profit",
  "totalProfit",
  "margin",
  "marginPercent",
  // Inventory (P2.1): stock valuation and purchase costing.
  "valueAtCost",
  "itemsSubtotal",
  "transportCost",
  "otherCost",
  "lineCost",
  "allocatedCost",
  "landedUnitCost",
  "wacBefore",
  "wacAfter",
  // Courier (P2.2): what WE pay the courier — it feeds per-order profit.
  "courierCostEstimate",
  "courierCostActual",
  "baseRate",
  "perKgRate",
  "returnCharge",
  "codChargePercent",
  "lastBalance",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !(value instanceof Date) && !Array.isArray(value);
}

function deepStrip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepStrip);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (COST_FIELD_NAMES.has(key)) continue;
      out[key] = deepStrip(val);
    }
    return out;
  }
  return value;
}

/** Pure, synchronous strip — call when you already know whether the caller has cost access. */
export function stripCostFields<T>(data: T, hasCostAccess: boolean): T {
  if (hasCostAccess) return data;
  return deepStrip(data) as T;
}

/** Convenience wrapper that resolves cost access via the RBAC layer, then strips. */
export async function stripCostFieldsForUser<T>(data: T, user: SessionUser | null | undefined): Promise<T> {
  const hasCostAccess = await can(user, "product.cost.view");
  return stripCostFields(data, hasCostAccess);
}
