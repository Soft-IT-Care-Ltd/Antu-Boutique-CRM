import "server-only";

import { Prisma } from "@prisma/client";

import type { Db } from "@/lib/db/tx";
import { DEFAULT_LOW_STOCK_THRESHOLD, LOW_STOCK_DEFAULT_SETTING_KEY } from "@/lib/catalog/constants";

// The threshold a variant without its own uses (PRD §4.2 "default from
// settings"). Read inside the SQL itself — an uncorrelated subquery Postgres
// evaluates once per statement — so every stock query, report and alert
// agrees with Settings without each caller threading the value through. The
// settings route only ever stores a whole number here, so the cast is safe.
export const LOW_STOCK_DEFAULT_SQL = Prisma.sql`COALESCE((SELECT NULLIF("value", '')::int FROM "settings" WHERE "key" = ${LOW_STOCK_DEFAULT_SETTING_KEY}), ${DEFAULT_LOW_STOCK_THRESHOLD}::int)`;

/** The same value, for screens that show it (the variant grid's placeholder). */
export async function getLowStockDefault(db: Db): Promise<number> {
  const row = await db.setting.findUnique({ where: { key: LOW_STOCK_DEFAULT_SETTING_KEY } });
  const n = row ? Number(row.value) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_LOW_STOCK_THRESHOLD;
}
