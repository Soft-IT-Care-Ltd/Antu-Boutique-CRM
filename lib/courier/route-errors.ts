import "server-only";

import { NextResponse } from "next/server";

import { CourierConfigError } from "@/lib/courier/integration";
import { PartialDeliveryError } from "@/lib/courier/partial-delivery";
import { StockMovementError } from "@/lib/inventory/ledger";
import { ConditionCheckError } from "@/lib/returns/condition-check";

/** Known business-rule failures → a readable 4xx; anything else is rethrown as a real 500. */
export function courierErrorResponse(error: unknown): NextResponse {
  if (error instanceof CourierConfigError) return NextResponse.json({ error: error.message }, { status: 400 });
  if (error instanceof ConditionCheckError || error instanceof PartialDeliveryError || error instanceof StockMovementError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  throw error;
}

export function zodError(issues: { message: string }[]): NextResponse {
  return NextResponse.json({ error: issues[0]?.message ?? "Invalid input" }, { status: 400 });
}
