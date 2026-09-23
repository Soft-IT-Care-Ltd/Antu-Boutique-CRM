import { NextResponse, type NextRequest } from "next/server";

import { timingSafeEqual } from "@/lib/courier/crypto";
import { CourierConfigError, getSteadfastIntegration } from "@/lib/courier/integration";
import { runSteadfastPoll } from "@/lib/courier/poll";
import { prisma } from "@/lib/prisma";

// The 15-minute polling fallback (STEADFAST_INTEGRATION.md §3B/§3C). Called
// by system cron / Vercel Cron with "Authorization: Bearer <CRON_SECRET>" —
// no session, so it's excluded from the login proxy. Fails closed when
// CRON_SECRET is unset. A disabled integration is a healthy no-op.
//
//   */15 * * * * curl -fsS -m 60 -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/steadfast-sync
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  const presented = request.headers.get("authorization") ?? "";
  if (!secret || !timingSafeEqual(presented, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const integration = await getSteadfastIntegration(prisma);
  if (!integration?.isEnabled) return NextResponse.json({ ok: true, skipped: "Steadfast integration is not enabled" });

  try {
    return NextResponse.json(await runSteadfastPoll(prisma));
  } catch (error) {
    if (error instanceof CourierConfigError) return NextResponse.json({ ok: false, skipped: error.message });
    console.error("Steadfast cron poll failed:", error);
    return NextResponse.json({ ok: false, error: "Poll failed" }, { status: 500 });
  }
}
