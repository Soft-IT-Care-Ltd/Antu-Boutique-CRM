import "server-only";

import { NextResponse } from "next/server";

import { StockMovementError } from "@/lib/inventory/ledger";
import { ScanError } from "@/lib/inventory/scan-lookup";
import { LocationError } from "@/lib/locations/service";
import { ShelfError } from "@/lib/shelves/engine";
import { ShelfLabelError } from "@/lib/shelves/labels";

/** Turns a C4b shelf error into its JSON response; null = not ours, rethrow. */
export function shelfErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof ScanError) return NextResponse.json({ error: err.message, refused: true }, { status: err.status });
  if (err instanceof ShelfError || err instanceof LocationError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof StockMovementError || err instanceof ShelfLabelError) return NextResponse.json({ error: err.message }, { status: 400 });
  return null;
}
