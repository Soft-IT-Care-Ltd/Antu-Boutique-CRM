import "server-only";

import type { PermissionKey } from "@/lib/auth/permission-definitions";
import { loadEffectivePermissions } from "@/lib/auth/permissions";
import type { Db } from "@/lib/db/tx";
import type { LowStockProductAlert } from "@/lib/inventory/types";

// PRD §4.18 / §7 — the daily low-stock alert (GET /api/cron/low-stock-alert).
// Once a Dhaka day, everyone who buys stock (inventory.purchase.create, per
// their effective permissions — role plus overrides) gets one in-app
// notification summarising the low-stock screen: how many products, the
// most urgent first with the PRD §4.2 roll-up ("Kurti #12: only XL left").
// Nothing low, nothing sent. Running twice in a day writes nothing new
// (unique userId + dedupeKey). Money-free: stock counts only.

export const LOW_STOCK_ALERT_PERMISSION: PermissionKey = "inventory.purchase.create";
const SHOWN = 5;
/** Notifications are alerts, not records: anything this old is cleared. */
const KEEP_NOTIFICATIONS_DAYS = 90;

export function lowStockAlertText(alerts: LowStockProductAlert[]): { title: string; body: string } {
  const out = alerts.reduce((n, a) => n + a.outCount, 0);
  const low = alerts.reduce((n, a) => n + a.lowCount, 0);
  const products = `${alerts.length} product${alerts.length === 1 ? "" : "s"}`;
  const counts = [out ? `${out} variant${out === 1 ? "" : "s"} out of stock` : null, low ? `${low} running low` : null].filter(Boolean).join(", ");
  const lines = alerts.slice(0, SHOWN).map((a) => `${a.productName} (${a.productCode}): ${a.message}`);
  if (alerts.length > SHOWN) lines.push(`…and ${alerts.length - SHOWN} more`);
  return { title: `Low stock: ${products} need restocking${counts ? ` — ${counts}` : ""}`, body: lines.join("\n") };
}

export type LowStockAlertSummary = { day: string; products: number; recipients: number; sent: number; cleared: number };

export async function sendLowStockAlert(db: Db, alerts: LowStockProductAlert[], day: string, now = new Date()): Promise<LowStockAlertSummary> {
  const cleared = (await db.notification.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - KEEP_NOTIFICATIONS_DAYS * 86_400_000) } } })).count;
  if (alerts.length === 0) return { day, products: 0, recipients: 0, sent: 0, cleared };

  const users = await db.user.findMany({ where: { isActive: true }, select: { id: true } });
  const recipients: string[] = [];
  for (const u of users) if ((await loadEffectivePermissions(db, u.id)).has(LOW_STOCK_ALERT_PERMISSION)) recipients.push(u.id);

  const { title, body } = lowStockAlertText(alerts);
  const { count } = await db.notification.createMany({
    data: recipients.map((userId) => ({ userId, kind: "LOW_STOCK" as const, title, body, href: "/inventory/low-stock", dedupeKey: `low-stock:${day}` })),
    skipDuplicates: true,
  });
  return { day, products: alerts.length, recipients: recipients.length, sent: count, cleared };
}
