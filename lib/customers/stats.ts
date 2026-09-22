import "server-only";

import { RISK_FLAG_REFUSED_COD_THRESHOLD } from "@/lib/customers/constants";
import type { CustomerStats } from "@/lib/customers/types";

// Orders, payments and returns/exchanges (PRD §4.6, §4.9) don't exist yet —
// they land in later Phase 1 prompts. Until then every customer's history is
// genuinely empty, so this returns the correct zero-state rather than
// querying tables that don't exist. When Order/Return models land, replace
// the body with real aggregates keyed on customerId; CustomerStats (and
// every caller of this function) does not need to change.
export async function computeCustomerStats(_customerId: string): Promise<CustomerStats> {
  const refusedCodCount = 0;

  return {
    lifetimeOrders: 0,
    lifetimeValue: "0",
    returnsExchangesCount: 0,
    averageOrderValue: "0",
    lastOrderDate: null,
    refusedCodCount,
    riskFlag: refusedCodCount >= RISK_FLAG_REFUSED_COD_THRESHOLD,
  };
}
