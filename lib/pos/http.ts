import "server-only";

import { NextResponse } from "next/server";

import { financeErrorResponse } from "@/lib/finance/http";
import { DrawerError } from "@/lib/pos/drawer";
import { PosSaleError, posSaleConflict } from "@/lib/pos/sale";

/** Maps the POS domain errors (and the P2.3 wallet/expense ones they reuse) to JSON; rethrows anything else. */
export function posErrorResponse(error: unknown): NextResponse {
  const conflict = posSaleConflict(error);
  const known = conflict ?? error;
  if (known instanceof PosSaleError || known instanceof DrawerError) {
    return NextResponse.json({ error: known.message }, { status: known.status });
  }
  return financeErrorResponse(error);
}
