import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { loadStatementDetail } from "@/lib/courier/cod-queries";

// The payout report (Gift Valy Round 2 §2.7): totals, the gross − charges =
// net identity, Σ our expected nets vs what they paid, and every line.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("courier.reconcile");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const statement = await loadStatementDetail(id);
  if (!statement) return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  return NextResponse.json({ statement });
}
