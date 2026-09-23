import { z } from "zod";

import { AD_PLATFORM_VALUES } from "@/lib/expenses/constants";
import { dayString, idString, money } from "@/lib/finance/http";

export const adSpendSchema = z.object({
  spendDate: dayString,
  platform: z.enum(AD_PLATFORM_VALUES).default("FACEBOOK"),
  amount: money,
  walletId: idString,
  note: z.string().trim().max(300).nullish(),
});
