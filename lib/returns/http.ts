import "server-only";

import { NextResponse } from "next/server";

import { ConditionCheckError } from "@/lib/returns/condition-check";
import { ReturnCaseError, returnCaseConflict } from "@/lib/returns/cases";
import { generateOrderInvoice } from "@/lib/orders/invoice";
import { IllegalTransitionError } from "@/lib/orders/lifecycle";
import { posErrorResponse } from "@/lib/pos/http";

/** Maps the returns/exchange domain errors (and the POS/wallet ones a counter exchange reuses) to JSON; rethrows anything else. */
export function returnsErrorResponse(error: unknown): NextResponse {
  const known = returnCaseConflict(error) ?? error;
  if (known instanceof ReturnCaseError) return NextResponse.json({ error: known.message }, { status: known.status });
  if (known instanceof ConditionCheckError) return NextResponse.json({ error: known.message }, { status: 409 });
  if (known instanceof IllegalTransitionError) return NextResponse.json({ error: known.message }, { status: 409 });
  return posErrorResponse(error);
}

/**
 * A return or exchange changed these orders' totals: each gets a new invoice
 * version, old ones kept (PRD §6 invariant 8). Best-effort, like every
 * invoice render — the money change is committed and audited either way.
 */
export async function regenerateInvoices(orderIds: string[], actorId: string): Promise<void> {
  for (const orderId of orderIds) {
    try {
      await generateOrderInvoice(orderId, actorId);
    } catch (error) {
      console.error(`Failed to regenerate the invoice for order ${orderId} after a return/exchange:`, error);
    }
  }
}
