import { NextResponse } from "next/server";
import { requirePermission, apiError } from "@/lib/authz";
import { logAudit } from "@/lib/audit";
import { runSteadfastPaymentsSync } from "@/lib/steadfast-payments";

// CORRECTIONS Orders §R8 — manual "Sync payments": the Courier-page button and
// the dashboard Total-Collection refresh icon both POST here. Pulls
// GET /payments (+ invoice details), reconciles paid payouts (GROSS per-order
// COD rows, the two real-charge expenses, NET into the payout wallet) and
// returns the run summary. Requires courier.manage, like the status sync.
export async function POST() {
  try {
    const session = await requirePermission("courier.manage");
    const summary = await runSteadfastPaymentsSync({ userId: session.user.id });

    await logAudit({
      userId: session.user.id,
      action: "courier_integration.payments_sync",
      entity: "steadfast_payments",
      after: summary,
    });

    return NextResponse.json(summary);
  } catch (e) {
    return apiError(e);
  }
}
