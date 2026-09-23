import { NextResponse, type NextRequest } from "next/server";

import { handleSteadfastWebhook } from "@/lib/courier/webhook";
import { prisma } from "@/lib/prisma";

// Steadfast → us (STEADFAST_INTEGRATION.md §3A). No session: excluded from
// the login proxy (proxy.ts) and authenticated by the Bearer token from the
// Courier page instead — a wrong or missing token is a 401 before anything
// is read or written. All logic lives in lib/courier/webhook.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => undefined);
  try {
    const result = await handleSteadfastWebhook(prisma, request.headers.get("authorization"), body);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    // Idempotent processing, so a 500 (Steadfast retries) is always safe.
    console.error("Steadfast webhook processing error:", error);
    return NextResponse.json({ status: "error", message: "Processing error" }, { status: 500 });
  }
}
