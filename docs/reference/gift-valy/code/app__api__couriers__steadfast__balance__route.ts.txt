import { NextResponse } from "next/server";
import { requirePermission, apiError } from "@/lib/authz";
import { getBalance } from "@/lib/steadfast";
import {
  getSteadfastIntegration,
  credsFromIntegration,
} from "@/lib/steadfast-integration";

// Balance widget on the Courier page (STEADFAST_INTEGRATION.md §1, moved per
// CORRECTIONS Courier §2) — refresh button. courier.manage: balance only,
// never the keys.
export async function GET() {
  try {
    await requirePermission("courier.manage");
    const integration = await getSteadfastIntegration();
    const creds = credsFromIntegration(integration);
    try {
      const balance = await getBalance(creds);
      return NextResponse.json({ ok: true, balance });
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: e instanceof Error ? e.message : "Failed to fetch balance" },
        { status: 200 }
      );
    }
  } catch (e) {
    return apiError(e);
  }
}
