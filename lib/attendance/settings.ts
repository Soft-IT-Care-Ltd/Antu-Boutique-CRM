import "server-only";

import type { Db } from "@/lib/db/tx";
import { OFFICE_HOURS_SETTING_KEY, parseOfficeHours, type OfficeHours } from "@/lib/attendance/office-hours";

// The office-hour settings (PRD §4.17), read with defaults so attendance
// works before Settings has ever been visited.

export async function getOfficeHours(db: Db): Promise<OfficeHours> {
  const row = await db.setting.findUnique({ where: { key: OFFICE_HOURS_SETTING_KEY } });
  return parseOfficeHours(row?.value ?? null);
}

export async function saveOfficeHours(db: Db, hours: OfficeHours, updatedById: string): Promise<void> {
  const value = JSON.stringify({ ...hours, holidays: [...new Set(hours.holidays)].sort(), weeklyOff: [...new Set(hours.weeklyOff)].sort() });
  await db.setting.upsert({ where: { key: OFFICE_HOURS_SETTING_KEY }, update: { value, updatedById }, create: { key: OFFICE_HOURS_SETTING_KEY, value, updatedById } });
}
