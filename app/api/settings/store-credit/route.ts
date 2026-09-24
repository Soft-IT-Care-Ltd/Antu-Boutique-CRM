import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { setSetting } from "@/lib/settings/get";
import { MAX_STORE_CREDIT_EXPIRY_DAYS, STORE_CREDIT_EXPIRY_SETTING_KEY } from "@/lib/store-credit/constants";
import { getStoreCreditExpiryDays } from "@/lib/store-credit/ledger";

// P3.2 — optional store credit expiry (PRD §4.17). No expiry by default.
// A change applies to credit added from then on; credit already issued
// keeps the expiry it was given.

export async function GET() {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  return NextResponse.json({ expiryDays: await getStoreCreditExpiryDays(prisma) });
}

const schema = z.object({
  expiryDays: z.coerce.number().int("Whole days only").min(1, "At least 1 day").max(MAX_STORE_CREDIT_EXPIRY_DAYS, "At most 10 years").nullable(),
});

export async function PUT(request: NextRequest) {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);
  const before = await getStoreCreditExpiryDays(prisma);
  await setSetting(STORE_CREDIT_EXPIRY_SETTING_KEY, parsed.data.expiryDays === null ? "" : String(parsed.data.expiryDays), guard.user.id);
  await writeAuditLog({
    actorId: guard.user.id,
    action: "setting.update",
    entityType: "setting",
    entityId: STORE_CREDIT_EXPIRY_SETTING_KEY,
    before: { expiryDays: before },
    after: { expiryDays: parsed.data.expiryDays },
    request,
  });
  return NextResponse.json({ expiryDays: parsed.data.expiryDays });
}
