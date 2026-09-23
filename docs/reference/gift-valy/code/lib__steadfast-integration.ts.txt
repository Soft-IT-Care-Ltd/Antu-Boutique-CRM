import type { CourierIntegration, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "./db";
import { AuthzError } from "./authz";
import { decryptSecret, timingSafeEqual, maskSecret } from "./crypto";
import type { SteadfastCreds } from "./steadfast";

type Tx = Prisma.TransactionClient | PrismaClient;

// ============ Steadfast integration accessors (STEADFAST_INTEGRATION.md §1/§5) ============
//
// One row per courier (only STEADFAST today). Keys/token are stored encrypted;
// this module is the only place that decrypts them, always server-side.

export const STEADFAST = "STEADFAST" as const;

export async function getSteadfastIntegration(
  db: Tx = prisma
): Promise<CourierIntegration | null> {
  return db.courierIntegration.findUnique({ where: { courier: STEADFAST } });
}

// Decrypt the API credentials. Throws if keys are not configured — callers that
// need to talk to Steadfast surface this as a clear "configure keys first".
export function credsFromIntegration(
  integration: CourierIntegration | null
): SteadfastCreds {
  if (!integration?.apiKeyEncrypted || !integration?.secretKeyEncrypted) {
    throw new AuthzError(400, "Steadfast API keys are not configured");
  }
  return {
    apiKey: decryptSecret(integration.apiKeyEncrypted),
    secretKey: decryptSecret(integration.secretKeyEncrypted),
  };
}

// For flows that must only run when the integration is turned on (send, poll).
export async function requireEnabledSteadfast(
  db: Tx = prisma
): Promise<{ integration: CourierIntegration; creds: SteadfastCreds }> {
  const integration = await getSteadfastIntegration(db);
  if (!integration || !integration.isEnabled) {
    throw new AuthzError(400, "Steadfast integration is not enabled");
  }
  return { integration, creds: credsFromIntegration(integration) };
}

// Bearer-token check for inbound webhooks (§3A). Constant-time; false when no
// token is configured or the presented value doesn't match.
export function verifyWebhookToken(
  integration: CourierIntegration | null,
  presented: string | null | undefined
): boolean {
  if (!integration?.webhookTokenEncrypted || !presented) return false;
  let stored: string;
  try {
    stored = decryptSecret(integration.webhookTokenEncrypted);
  } catch {
    return false;
  }
  return timingSafeEqual(stored, presented);
}

// Extract the Bearer token from an Authorization header value.
export function bearerFromHeader(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

// The masked, secret-free view the Settings page renders (§1: keys never sent to
// the client after save). callbackUrl is built from the request/host by the route.
export function serializeIntegration(
  integration: CourierIntegration | null,
  opts: { callbackUrl: string; webhookTokenPlain?: string | null }
) {
  const apiKeyMasked = integration?.apiKeyEncrypted
    ? maskSecret(safeDecrypt(integration.apiKeyEncrypted))
    : null;
  const secretKeyMasked = integration?.secretKeyEncrypted
    ? maskSecret(safeDecrypt(integration.secretKeyEncrypted))
    : null;
  const webhookTokenMasked = integration?.webhookTokenEncrypted
    ? maskSecret(safeDecrypt(integration.webhookTokenEncrypted))
    : null;

  return {
    configured: !!(integration?.apiKeyEncrypted && integration?.secretKeyEncrypted),
    isEnabled: integration?.isEnabled ?? false,
    pollingMinutes: integration?.pollingMinutes ?? 60,
    apiKeyMasked,
    secretKeyMasked,
    hasWebhookToken: !!integration?.webhookTokenEncrypted,
    webhookTokenMasked,
    // Present only right after a (re)generate — shown once so it can be copied.
    webhookTokenPlain: opts.webhookTokenPlain ?? null,
    callbackUrl: opts.callbackUrl,
    connectedAt: integration?.connectedAt?.toISOString() ?? null,
    lastSyncAt: integration?.lastSyncAt?.toISOString() ?? null,
    lastWebhookAt: integration?.lastWebhookAt?.toISOString() ?? null,
    lastPaymentsSyncAt: integration?.lastPaymentsSyncAt?.toISOString() ?? null,
  };
}

function safeDecrypt(value: string): string {
  try {
    return decryptSecret(value);
  } catch {
    return "";
  }
}
