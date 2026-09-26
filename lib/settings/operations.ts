import "server-only";

import { z } from "zod";

import type { Db } from "@/lib/db/tx";
import { LOW_STOCK_DEFAULT_SETTING_KEY } from "@/lib/catalog/constants";
import { getLowStockDefault } from "@/lib/catalog/low-stock-threshold";
import { DEFAULT_ORDER_EDIT_WINDOW_MINUTES, DEFAULT_PACKING_SLA_HOURS, ORDER_EDIT_WINDOW_SETTING_KEY, PACKING_SLA_HOURS_SETTING_KEY } from "@/lib/settings/get";

// PRD §4.17 "order edit-window minutes" and "low-stock default threshold",
// plus the packing SLA the queue colours by (PRD §4.8) — three numbers that
// already drive the app with defaults, now editable in one card.

export const operationsSchema = z.object({
  orderEditWindowMinutes: z.coerce.number().int("Whole minutes only").min(1, "At least 1 minute").max(1440, "At most a day (1440 minutes)"),
  packingSlaHours: z.coerce.number().int("Whole hours only").min(1, "At least 1 hour").max(168, "At most a week (168 hours)"),
  lowStockDefault: z.coerce.number().int("Whole units only").min(0, "0 or more").max(1000, "At most 1000"),
});

export type OperationsSettings = z.infer<typeof operationsSchema>;

const KEYS: Record<keyof OperationsSettings, string> = {
  orderEditWindowMinutes: ORDER_EDIT_WINDOW_SETTING_KEY,
  packingSlaHours: PACKING_SLA_HOURS_SETTING_KEY,
  lowStockDefault: LOW_STOCK_DEFAULT_SETTING_KEY,
};

function positive(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export async function getOperationsSettings(db: Db): Promise<OperationsSettings> {
  const rows = await db.setting.findMany({ where: { key: { in: [ORDER_EDIT_WINDOW_SETTING_KEY, PACKING_SLA_HOURS_SETTING_KEY] } } });
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  return {
    orderEditWindowMinutes: positive(value(ORDER_EDIT_WINDOW_SETTING_KEY), DEFAULT_ORDER_EDIT_WINDOW_MINUTES),
    packingSlaHours: positive(value(PACKING_SLA_HOURS_SETTING_KEY), DEFAULT_PACKING_SLA_HOURS),
    lowStockDefault: await getLowStockDefault(db),
  };
}

export async function saveOperationsSettings(db: Db, input: OperationsSettings, updatedById: string): Promise<void> {
  for (const [field, key] of Object.entries(KEYS) as [keyof OperationsSettings, string][]) {
    const value = String(input[field]);
    await db.setting.upsert({ where: { key }, update: { value, updatedById }, create: { key, value, updatedById } });
  }
}
