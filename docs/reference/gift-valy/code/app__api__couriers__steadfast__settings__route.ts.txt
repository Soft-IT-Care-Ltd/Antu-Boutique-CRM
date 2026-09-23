import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission, apiError, AuthzError } from "@/lib/authz";
import { logAudit } from "@/lib/audit";
import { encryptSecret } from "@/lib/crypto";
import {
  STEADFAST,
  getSteadfastIntegration,
  serializeIntegration,
} from "@/lib/steadfast-integration";

// Settings → Courier Integrations → Steadfast (STEADFAST_INTEGRATION.md §1).
// Admin-only (settings.manage). Keys are encrypted at rest and never returned
// to the client (masked view only, §1 / §5).

function callbackUrl(req: Request): string {
  const base =
    process.env.NEXTAUTH_URL?.replace(/\/$/, "") || new URL(req.url).origin;
  return `${base}/api/webhooks/steadfast`;
}

export async function GET(req: Request) {
  try {
    await requirePermission("settings.manage");
    const integration = await getSteadfastIntegration();
    return NextResponse.json(
      serializeIntegration(integration, { callbackUrl: callbackUrl(req) })
    );
  } catch (e) {
    return apiError(e);
  }
}

const bodySchema = z.object({
  // Empty/omitted → keep the stored key (so saving toggles without re-typing keys).
  apiKey: z.string().optional(),
  secretKey: z.string().optional(),
  isEnabled: z.boolean().optional(),
  pollingMinutes: z.number().int().min(1).max(1440).optional(),
});

export async function PUT(req: Request) {
  try {
    const session = await requirePermission("settings.manage");
    const data = bodySchema.parse(await req.json());
    const existing = await getSteadfastIntegration();

    const apiKey = data.apiKey?.trim();
    const secretKey = data.secretKey?.trim();

    const willHaveApiKey = apiKey ? true : !!existing?.apiKeyEncrypted;
    const willHaveSecret = secretKey ? true : !!existing?.secretKeyEncrypted;
    if (data.isEnabled && (!willHaveApiKey || !willHaveSecret)) {
      throw new AuthzError(
        400,
        "Enter both API Key and Secret Key before enabling the integration"
      );
    }

    const integration = await prisma.courierIntegration.upsert({
      where: { courier: STEADFAST },
      create: {
        courier: STEADFAST,
        apiKeyEncrypted: apiKey ? encryptSecret(apiKey) : null,
        secretKeyEncrypted: secretKey ? encryptSecret(secretKey) : null,
        isEnabled: data.isEnabled ?? false,
        pollingMinutes: data.pollingMinutes ?? 60,
      },
      update: {
        ...(apiKey ? { apiKeyEncrypted: encryptSecret(apiKey) } : {}),
        ...(secretKey ? { secretKeyEncrypted: encryptSecret(secretKey) } : {}),
        ...(data.isEnabled !== undefined ? { isEnabled: data.isEnabled } : {}),
        ...(data.pollingMinutes !== undefined
          ? { pollingMinutes: data.pollingMinutes }
          : {}),
      },
    });

    await logAudit({
      userId: session.user.id,
      action: "courier_integration.settings.update",
      entity: "courier_integrations",
      entityId: integration.id,
      // Never log secrets — only which fields changed and the non-secret state.
      after: {
        courier: STEADFAST,
        isEnabled: integration.isEnabled,
        pollingMinutes: integration.pollingMinutes,
        apiKeyChanged: !!apiKey,
        secretKeyChanged: !!secretKey,
      },
    });

    return NextResponse.json(
      serializeIntegration(integration, { callbackUrl: callbackUrl(req) })
    );
  } catch (e) {
    return apiError(e);
  }
}
