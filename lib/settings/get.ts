import "server-only";

import { prisma } from "@/lib/prisma";

// PRD §5 SETTINGS group — key/value store. Phase 5 builds the editing UI;
// every reader here must degrade to a sane default when the row is absent
// so nothing depends on Settings having been visited first.

export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string, updatedById: string | null): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value, updatedById },
    create: { key, value, updatedById },
  });
}

export const ORDER_EDIT_WINDOW_SETTING_KEY = "order_edit_window_minutes";
export const DEFAULT_ORDER_EDIT_WINDOW_MINUTES = 30;

// PRD §4.6: "an SE may edit freely for X minutes after creation (default
// 30, set in Settings)."
export async function getOrderEditWindowMinutes(): Promise<number> {
  const raw = await getSetting(ORDER_EDIT_WINDOW_SETTING_KEY);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ORDER_EDIT_WINDOW_MINUTES;
}

export const PACKING_SLA_HOURS_SETTING_KEY = "packing_sla_hours";
export const DEFAULT_PACKING_SLA_HOURS = 24;

// PRD §4.8: "SLA colouring — overdue orders turn red." How many hours a
// CONFIRMED order may sit in the packing queue before it counts as overdue.
export async function getPackingSlaHours(): Promise<number> {
  const raw = await getSetting(PACKING_SLA_HOURS_SETTING_KEY);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PACKING_SLA_HOURS;
}
