import "server-only";

import { NextResponse } from "next/server";

import { LocationError } from "@/lib/locations/service";
import { ScanError } from "@/lib/inventory/scan-lookup";
import { StockMovementError } from "@/lib/inventory/ledger";
import { StockCountError } from "@/lib/stock-counts/service";
import { TransferError } from "@/lib/transfers/service";

/** Turns a C4 stock-document error into its JSON response; null = not ours, rethrow. */
export function stockDocumentErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof ScanError) return NextResponse.json({ error: err.message, refused: true }, { status: err.status });
  if (err instanceof TransferError || err instanceof StockCountError || err instanceof LocationError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof StockMovementError) return NextResponse.json({ error: err.message }, { status: 400 });
  return null;
}
