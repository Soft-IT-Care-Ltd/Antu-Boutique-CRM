import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { writeAuditLog } from "@/lib/audit/log";
import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { PAYMENT_METHOD_VALUES } from "@/lib/orders/constants";
import { PAYMENT_METHODS_SETTING_KEY } from "@/lib/payments/method-settings";
import { getEnabledPaymentMethods } from "@/lib/payments/methods";
import { prisma } from "@/lib/prisma";
import { setSetting } from "@/lib/settings/get";

// PRD §4.17 payment methods: which of bKash / Nagad / Rocket / Bank / Cash /
// Card staff can pick. GET is for every payment picker, so any signed-in
// person may read it (it is only a list of method names); PUT is Admin.

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ enabled: await getEnabledPaymentMethods(prisma) });
}

const schema = z.object({
  enabled: z
    .array(z.enum(PAYMENT_METHOD_VALUES))
    .min(1, "Keep at least one payment method switched on")
    .transform((list) => PAYMENT_METHOD_VALUES.filter((m) => list.includes(m))),
});

export async function PUT(request: NextRequest) {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const before = await getEnabledPaymentMethods(prisma);
  await setSetting(PAYMENT_METHODS_SETTING_KEY, JSON.stringify(parsed.data.enabled), guard.user.id);
  await writeAuditLog({ actorId: guard.user.id, action: "setting.update", entityType: "setting", entityId: PAYMENT_METHODS_SETTING_KEY, before: { enabled: before }, after: { enabled: parsed.data.enabled }, request });
  return NextResponse.json({ enabled: parsed.data.enabled });
}
