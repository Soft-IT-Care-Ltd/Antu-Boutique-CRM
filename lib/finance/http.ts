import "server-only";

import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import { ExpenseError } from "@/lib/expenses/service";
import { monthStartInDhaka } from "@/lib/finance/dates";
import { dhakaDayStartUtc, todayInDhaka } from "@/lib/inventory/constants";
import { RefundError } from "@/lib/payments/refunds";
import { WalletError } from "@/lib/wallets/service";

// Shared by the P2.3 wallet / payment / expense / report routes.

export const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD");
export const money = z.coerce.number({ error: "Enter an amount" }).positive("Enter an amount greater than zero").max(100_000_000, "Amount is too large");
export const idString = z.string().trim().min(1).max(50);

/**
 * Inclusive Dhaka days → [from, to) UTC instants. Defaults to this month so
 * far. `to` before `from` is rejected by the caller's schema refine.
 */
export function dayRange(fromDay?: string, toDay?: string): { fromDay: string; toDay: string; from: Date; to: Date } {
  const f = fromDay || monthStartInDhaka();
  const t = toDay || todayInDhaka();
  return { fromDay: f, toDay: t, from: dhakaDayStartUtc(f), to: dhakaDayStartUtc(t, 1) };
}

export function badRequest(error: z.ZodError) {
  return NextResponse.json({ error: error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
}

/** Maps the P2.3 domain errors and a reused transaction ID to a JSON response; rethrows anything else. */
export function financeErrorResponse(error: unknown): NextResponse {
  if (error instanceof WalletError || error instanceof ExpenseError || error instanceof RefundError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return NextResponse.json({ error: "This transaction ID has already been used" }, { status: 409 });
  }
  throw error;
}
