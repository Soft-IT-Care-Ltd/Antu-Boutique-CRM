import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermission, apiError } from "@/lib/authz";
import { logAudit } from "@/lib/audit";
import { getBalance } from "@/lib/steadfast";
import {
  getSteadfastIntegration,
  credsFromIntegration,
} from "@/lib/steadfast-integration";

// "Test Connection" (STEADFAST_INTEGRATION.md §1): calls GET /get_balance with
// the stored keys. Success → show balance + stamp connected_at. Failure → return
// the error (the client keeps the integration disabled). Never throws to a 500
// on a courier-side error — a bad key is a 400 with a readable message (§5).
// courier.manage: the button lives on the Courier page (CORRECTIONS Courier §2)
// and reveals only the balance — never the keys.
export async function POST() {
  try {
    const session = await requirePermission("courier.manage");
    const integration = await getSteadfastIntegration();
    const creds = credsFromIntegration(integration); // 400 if keys missing

    let balance: number;
    try {
      balance = await getBalance(creds);
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          error: e instanceof Error ? e.message : "Connection failed",
        },
        { status: 200 }
      );
    }

    await prisma.courierIntegration.update({
      where: { id: integration!.id },
      data: { connectedAt: new Date() },
    });
    await logAudit({
      userId: session.user.id,
      action: "courier_integration.test_connection",
      entity: "courier_integrations",
      entityId: integration!.id,
      after: { ok: true },
    });

    return NextResponse.json({ ok: true, balance });
  } catch (e) {
    return apiError(e);
  }
}
