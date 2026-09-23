import "server-only";

import { writeAuditLogWith } from "@/lib/audit/log";
import { credsFromIntegration, getSteadfastIntegration } from "@/lib/courier/integration";
import * as steadfast from "@/lib/courier/steadfast/client";
import type { Db } from "@/lib/db/tx";

// "Test Connection" and the balance widget — GET /get_balance, the one
// Steadfast call that is always allowed to reach the real API. A courier-side
// failure (wrong keys, Steadfast down) is a readable { ok: false } result,
// never a thrown 500.

export type BalanceResult = { ok: true; balance: number } | { ok: false; error: string };

async function fetchBalance(db: Db): Promise<{ result: BalanceResult; integrationId: string | null }> {
  const integration = await getSteadfastIntegration(db);
  let creds: steadfast.SteadfastCreds;
  try {
    creds = credsFromIntegration(integration);
  } catch (err) {
    return { result: { ok: false, error: err instanceof Error ? err.message : "Keys not configured" }, integrationId: integration?.id ?? null };
  }
  try {
    const balance = await steadfast.getBalance(creds);
    return { result: { ok: true, balance }, integrationId: integration!.id };
  } catch (err) {
    const status = err instanceof steadfast.SteadfastApiError ? err.status : undefined;
    const message = err instanceof Error ? err.message : "Connection failed";
    return {
      result: { ok: false, error: status === 401 || status === 403 ? `Steadfast rejected the API key/secret (${message})` : message },
      integrationId: integration!.id,
    };
  }
}

export async function testSteadfastConnection(db: Db, actorId: string): Promise<BalanceResult> {
  const { result, integrationId } = await fetchBalance(db);
  if (integrationId) {
    if (result.ok) {
      const now = new Date();
      await db.courierIntegration.update({ where: { id: integrationId }, data: { connectedAt: now, lastBalance: result.balance, lastBalanceAt: now } });
    }
    await writeAuditLogWith(db, {
      actorId,
      action: "courier.steadfast.test_connection",
      entityType: "courier_integration",
      entityId: integrationId,
      after: result.ok ? { ok: true } : { ok: false, error: result.error },
    });
  }
  return result;
}

export async function refreshSteadfastBalance(db: Db): Promise<BalanceResult> {
  const { result, integrationId } = await fetchBalance(db);
  if (result.ok && integrationId) {
    await db.courierIntegration.update({ where: { id: integrationId }, data: { lastBalance: result.balance, lastBalanceAt: new Date() } });
  }
  return result;
}
