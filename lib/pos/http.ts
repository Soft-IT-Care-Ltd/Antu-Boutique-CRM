import "server-only";

import { NextResponse } from "next/server";

import { financeErrorResponse } from "@/lib/finance/http";
import { LocationError } from "@/lib/locations/service";
import { DrawerError } from "@/lib/pos/drawer";
import { NegativeStockConfirmError, PosSaleError, posSaleConflict } from "@/lib/pos/sale";

/** Maps the POS domain errors (and the P2.3 wallet/expense ones they reuse) to JSON; rethrows anything else. */
export function posErrorResponse(error: unknown): NextResponse {
  const conflict = posSaleConflict(error);
  const known = conflict ?? error;
  // C3 — the POS asks the operator to confirm, then sends the sale again.
  if (known instanceof NegativeStockConfirmError) {
    return NextResponse.json({ error: known.message, code: "CONFIRM_NEGATIVE_STOCK", locationName: known.locationName, shortages: known.shortages }, { status: 409 });
  }
  if (known instanceof PosSaleError || known instanceof DrawerError || known instanceof LocationError) {
    return NextResponse.json({ error: known.message }, { status: known.status });
  }
  return financeErrorResponse(error);
}
