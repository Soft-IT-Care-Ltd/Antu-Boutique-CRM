import "server-only";

import type { CourierIntegration } from "@prisma/client";

import { decryptSecret, maskSecret, timingSafeEqual } from "@/lib/courier/crypto";
import type { SteadfastCreds } from "@/lib/courier/steadfast/client";
import type { Db } from "@/lib/db/tx";

// The Steadfast integration row and the courier company it drives. This is
// the only module that decrypts the stored API key/secret/webhook token, and
// it only ever does so server-side (PRD §4.9). The browser gets
// serializeIntegration()'s masked view — never a key.

export class CourierConfigError extends Error {}

/** The courier_companies row flagged provider = STEADFAST (seeded; created on first save otherwise). */
export async function getSteadfastCourier(db: Db) {
  return db.courierCompany.findUnique({ where: { provider: "STEADFAST" }, select: { id: true, name: true } });
}

export async function ensureSteadfastCourier(db: Db): Promise<{ id: string; name: string }> {
  const existing = await getSteadfastCourier(db);
  if (existing) return existing;
  return db.courierCompany.upsert({
    where: { name: "Steadfast Courier" },
    update: { provider: "STEADFAST" },
    create: { name: "Steadfast Courier", provider: "STEADFAST", contact: "16374" },
    select: { id: true, name: true },
  });
}

export async function getSteadfastIntegration(db: Db): Promise<CourierIntegration | null> {
  return db.courierIntegration.findUnique({ where: { provider: "STEADFAST" } });
}

export function credsFromIntegration(integration: CourierIntegration | null): SteadfastCreds {
  if (!integration?.apiKeyEncrypted || !integration?.secretKeyEncrypted) {
    throw new CourierConfigError("Steadfast API key and secret are not configured");
  }
  return { apiKey: decryptSecret(integration.apiKeyEncrypted), secretKey: decryptSecret(integration.secretKeyEncrypted) };
}

/** For flows that must only run with the integration switched on (send, poll). */
export async function requireEnabledSteadfast(db: Db): Promise<{ integration: CourierIntegration; creds: SteadfastCreds; courierId: string }> {
  const integration = await getSteadfastIntegration(db);
  if (!integration?.isEnabled) throw new CourierConfigError("Steadfast integration is not enabled");
  return { integration, creds: credsFromIntegration(integration), courierId: integration.courierId };
}

export function bearerFromHeader(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  return m ? m[1].trim() : null;
}

/** Constant-time check of the webhook's Bearer token against the stored one. False when none is configured. */
export function verifyWebhookToken(integration: CourierIntegration | null, presented: string | null): boolean {
  if (!integration?.webhookTokenEncrypted || !presented) return false;
  try {
    return timingSafeEqual(decryptSecret(integration.webhookTokenEncrypted), presented);
  } catch {
    return false;
  }
}

export function steadfastCallbackUrl(requestUrl?: string): string {
  const base = process.env.NEXTAUTH_URL?.replace(/\/$/, "") || (requestUrl ? new URL(requestUrl).origin : "");
  return `${base}/api/webhooks/steadfast`;
}

export type SteadfastSettingsView = {
  configured: boolean;
  isEnabled: boolean;
  pollingMinutes: number;
  apiKeyMasked: string | null;
  secretKeyMasked: string | null;
  hasWebhookToken: boolean;
  webhookTokenMasked: string | null;
  /** Present only in the response to a (re)generate — shown once so it can be copied into Steadfast. */
  webhookTokenPlain: string | null;
  callbackUrl: string;
  connectedAt: string | null;
  lastBalance: string | null;
  lastBalanceAt: string | null;
  lastSyncAt: string | null;
  lastWebhookAt: string | null;
  liveApiEnabled: boolean;
};

function safeMask(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return maskSecret(decryptSecret(value));
  } catch {
    return "(unreadable — re-enter)";
  }
}

export function serializeIntegration(integration: CourierIntegration | null, opts: { callbackUrl: string; webhookTokenPlain?: string | null }): SteadfastSettingsView {
  return {
    configured: Boolean(integration?.apiKeyEncrypted && integration?.secretKeyEncrypted),
    isEnabled: integration?.isEnabled ?? false,
    pollingMinutes: integration?.pollingMinutes ?? 15,
    apiKeyMasked: safeMask(integration?.apiKeyEncrypted),
    secretKeyMasked: safeMask(integration?.secretKeyEncrypted),
    hasWebhookToken: Boolean(integration?.webhookTokenEncrypted),
    webhookTokenMasked: safeMask(integration?.webhookTokenEncrypted),
    webhookTokenPlain: opts.webhookTokenPlain ?? null,
    callbackUrl: opts.callbackUrl,
    connectedAt: integration?.connectedAt?.toISOString() ?? null,
    lastBalance: integration?.lastBalance?.toString() ?? null,
    lastBalanceAt: integration?.lastBalanceAt?.toISOString() ?? null,
    lastSyncAt: integration?.lastSyncAt?.toISOString() ?? null,
    lastWebhookAt: integration?.lastWebhookAt?.toISOString() ?? null,
    liveApiEnabled: process.env.STEADFAST_LIVE_API === "enabled",
  };
}
