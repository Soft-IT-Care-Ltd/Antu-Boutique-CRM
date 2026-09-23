import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/audit/log";
import { requirePermission } from "@/lib/auth/require-permission";
import { encryptSecret, generateToken } from "@/lib/courier/crypto";
import { ensureSteadfastCourier, getSteadfastIntegration, serializeIntegration, steadfastCallbackUrl } from "@/lib/courier/integration";
import { prisma } from "@/lib/prisma";

// Generate / regenerate the webhook Bearer token (STEADFAST_INTEGRATION.md
// §3A). The plaintext is in THIS response only, so it can be copied into the
// Steadfast panel; afterwards only the masked form is ever shown.
// Regenerating immediately invalidates the old token.
export async function POST(request: NextRequest) {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;

  const courier = await ensureSteadfastCourier(prisma);
  const existing = await getSteadfastIntegration(prisma);
  const token = generateToken();
  const integration = await prisma.courierIntegration.upsert({
    where: { provider: "STEADFAST" },
    create: { provider: "STEADFAST", courierId: courier.id, webhookTokenEncrypted: encryptSecret(token) },
    update: { webhookTokenEncrypted: encryptSecret(token) },
  });

  await writeAuditLog({
    actorId: guard.user.id,
    action: existing?.webhookTokenEncrypted ? "courier.steadfast.webhook_token_regenerate" : "courier.steadfast.webhook_token_generate",
    entityType: "courier_integration",
    entityId: integration.id,
    request,
  });

  return NextResponse.json(serializeIntegration(integration, { callbackUrl: steadfastCallbackUrl(request.url), webhookTokenPlain: token }));
}
