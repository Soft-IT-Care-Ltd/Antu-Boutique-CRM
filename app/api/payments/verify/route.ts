import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest, idString } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { verifyPayments } from "@/lib/payments/queries";

// Accounts works the queue: verify one or many at once. Each verified
// payment gets its own audit row; only then does it count in its wallet.
const bodySchema = z.object({ paymentIds: z.array(idString).min(1, "Pick at least one payment").max(200) });

export async function POST(request: NextRequest) {
  const guard = await requirePermission("payment.verify");
  if (!guard.ok) return guard.response;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const verified = await prisma.$transaction((tx) => verifyPayments(tx, guard.user, parsed.data.paymentIds), { timeout: 30_000 });
  return NextResponse.json({ verified });
}
