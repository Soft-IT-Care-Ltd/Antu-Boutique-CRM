import { NextResponse } from "next/server";
import { getSteadfastIntegration } from "@/lib/steadfast-integration";
import { runSteadfastPoll } from "@/lib/steadfast-sync";
import {
  runSteadfastPaymentsSync,
  PAYMENTS_SYNC_MIN_GAP_MS,
  type PaymentsSyncSummary,
} from "@/lib/steadfast-payments";
import { timingSafeEqual } from "@/lib/crypto";
import { AuthzError } from "@/lib/authz";

// Scheduled Steadfast poll (STEADFAST_INTEGRATION.md §3B) — the unattended
// counterpart of the "Sync now" button. Called by Vercel Cron (vercel.json) or a
// plain system cron on a VPS; secured by CRON_SECRET, not a user session, since
// no user is present. runSteadfastPoll itself only touches non-final shipments
// whose last webhook/poll update is older than the configured polling interval,
// so the cron can fire more often than the interval without over-polling.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  // Fail closed when the secret is unset; Vercel Cron sends the CRON_SECRET env
  // var as "Authorization: Bearer <secret>" automatically, and a VPS cron passes
  // the same header (see the doc). Constant-time compare, like the webhook.
  const secret = process.env.CRON_SECRET;
  const presented = req.headers.get("authorization");
  if (!secret || !presented || !timingSafeEqual(presented, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Integration off (or keys missing) is a healthy no-op, not a cron failure —
  // never spam the scheduler with errors over a config state (§5).
  const integration = await getSteadfastIntegration();
  if (!integration?.isEnabled) {
    return NextResponse.json({ ok: true, skipped: "Steadfast integration is not enabled" });
  }

  try {
    const summary = await runSteadfastPoll();

    // CORRECTIONS Orders §R8 — the payments sync ("hourly poller") rides this
    // */15 cron on its own clock: it only runs when the last payments sync is
    // at least an hour old, so GET /payments is never over-called. A payments
    // failure must not fail the status poll that already succeeded.
    let payments: PaymentsSyncSummary | { skipped: string } = {
      skipped: "ran recently",
    };
    const due =
      integration.lastPaymentsSyncAt == null ||
      Date.now() - integration.lastPaymentsSyncAt.getTime() >=
        PAYMENTS_SYNC_MIN_GAP_MS;
    if (due) {
      try {
        payments = await runSteadfastPaymentsSync();
      } catch (e) {
        payments = {
          skipped: e instanceof Error ? e.message : "payments sync failed",
        };
      }
    }

    return NextResponse.json({ ok: true, ...summary, payments });
  } catch (e) {
    if (e instanceof AuthzError) {
      return NextResponse.json({ ok: false, skipped: e.message });
    }
    console.error("Steadfast cron poll failed:", e);
    return NextResponse.json({ ok: false, error: "Poll failed" }, { status: 500 });
  }
}
