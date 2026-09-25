import "server-only";

import { z } from "zod";

import type { SessionUser } from "@/lib/auth/types";
import { targetViewLevel } from "@/lib/targets/http";
import { dhakaMonth, MONTH_PATTERN, monthOptions } from "@/lib/targets/month";

/** The month a target screen shows (?month=, else this one) and the picker's choices. */
export async function targetPageContext(user: SessionUser, searchParams: Promise<Record<string, string | string[] | undefined>>, opts: { ahead?: number } = {}) {
  const current = dhakaMonth();
  const raw = (await searchParams).month;
  const month = z.string().regex(MONTH_PATTERN).catch(current).parse(raw);
  const months = monthOptions(current, 11, opts.ahead ?? 0);
  if (!months.includes(month)) months.unshift(month);
  const level = (await targetViewLevel(user))!;
  return { current, month, months: months.sort().reverse(), level };
}
