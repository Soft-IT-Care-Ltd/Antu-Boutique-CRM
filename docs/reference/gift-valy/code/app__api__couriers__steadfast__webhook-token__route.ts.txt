import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requirePermission, apiError } from "@/lib/authz";
import { logAudit } from "@/lib/audit";
import { encryptSecret, generateToken } from "@/lib/crypto";
import { STEADFAST, getSteadfastIntegration } from "@/lib/steadfast-integration";

// Generate / regenerate the inbound webhook Bearer token
// (STEADFAST_INTEGRATION.md §3A). Returned in plaintext exactly ONCE so it can be
// copied into the Steadfast panel; stored encrypted, never shown again after.
export async function POST() {
  try {
    const session = await requirePermission("settings.manage");
    const existing = await getSteadfastIntegration();

    const token = generateToken(32); // 32 bytes → 43 base64url chars (§3A: 32+)
    const encrypted = encryptSecret(token);

    const integration = await prisma.courierIntegration.upsert({
      where: { courier: STEADFAST },
      create: { courier: STEADFAST, webhookTokenEncrypted: encrypted },
      update: { webhookTokenEncrypted: encrypted },
    });

    await logAudit({
      userId: session.user.id,
      action: existing?.webhookTokenEncrypted
        ? "courier_integration.webhook_token.regenerate"
        : "courier_integration.webhook_token.generate",
      entity: "courier_integrations",
      entityId: integration.id,
    });

    // Plaintext token in the response body only — shown once.
    return NextResponse.json({ token });
  } catch (e) {
    return apiError(e);
  }
}
