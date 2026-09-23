import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { requirePermission } from "@/lib/auth/require-permission";
import { encryptSecret } from "@/lib/courier/crypto";
import { ensureSteadfastCourier, getSteadfastIntegration, serializeIntegration, steadfastCallbackUrl } from "@/lib/courier/integration";
import { zodError } from "@/lib/courier/route-errors";
import { prisma } from "@/lib/prisma";

// The Steadfast panel on the Courier page (STEADFAST_INTEGRATION.md §1).
// GET: the masked view — never a key, not even to an Admin. PUT: Admin only
// (settings.manage). Keys arrive here once, are encrypted with
// COURIER_ENCRYPTION_KEY and never leave the server again.

export async function GET(request: NextRequest) {
  const guard = await requirePermission(["courier.manage", "settings.manage"]);
  if (!guard.ok) return guard.response;
  const integration = await getSteadfastIntegration(prisma);
  return NextResponse.json(serializeIntegration(integration, { callbackUrl: steadfastCallbackUrl(request.url) }));
}

const updateSchema = z.object({
  // Blank/omitted keeps the stored value, so toggling "enabled" never needs the keys re-typed.
  apiKey: z.string().trim().max(200).optional(),
  secretKey: z.string().trim().max(200).optional(),
  isEnabled: z.boolean().optional(),
  pollingMinutes: z.coerce.number().int().min(5).max(1440).optional(),
});

export async function PUT(request: NextRequest) {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return zodError(parsed.error.issues);
  const { apiKey, secretKey, isEnabled, pollingMinutes } = parsed.data;

  const courier = await ensureSteadfastCourier(prisma);
  const existing = await getSteadfastIntegration(prisma);
  const willHaveKeys = Boolean(apiKey || existing?.apiKeyEncrypted) && Boolean(secretKey || existing?.secretKeyEncrypted);
  if (isEnabled && !willHaveKeys) {
    return NextResponse.json({ error: "Enter both the API key and the secret key before enabling the integration" }, { status: 400 });
  }

  const keyData = {
    ...(apiKey ? { apiKeyEncrypted: encryptSecret(apiKey) } : {}),
    ...(secretKey ? { secretKeyEncrypted: encryptSecret(secretKey) } : {}),
    // New keys → the old "connected" stamp no longer vouches for anything.
    ...(apiKey || secretKey ? { connectedAt: null, lastBalance: null, lastBalanceAt: null } : {}),
  };
  const integration = await prisma.courierIntegration.upsert({
    where: { provider: "STEADFAST" },
    create: { provider: "STEADFAST", courierId: courier.id, ...keyData, isEnabled: isEnabled ?? false, pollingMinutes: pollingMinutes ?? 15 },
    update: { ...keyData, ...(isEnabled !== undefined ? { isEnabled } : {}), ...(pollingMinutes !== undefined ? { pollingMinutes } : {}) },
  });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "courier.steadfast.settings_update",
    entityType: "courier_integration",
    entityId: integration.id,
    // Never the secrets themselves — only that they changed.
    before: existing ? { isEnabled: existing.isEnabled, pollingMinutes: existing.pollingMinutes } : null,
    after: { isEnabled: integration.isEnabled, pollingMinutes: integration.pollingMinutes, apiKeyChanged: Boolean(apiKey), secretKeyChanged: Boolean(secretKey) },
    request,
  });

  return NextResponse.json(serializeIntegration(integration, { callbackUrl: steadfastCallbackUrl(request.url) }));
}
