import { z } from "zod";

import { AD_PLATFORM_VALUES } from "@/lib/expenses/constants";
import { idString, money, moneyDayString } from "@/lib/finance/http";

export const adSpendSchema = z.object({
  spendDate: moneyDayString,
  platform: z.enum(AD_PLATFORM_VALUES).default("FACEBOOK"),
  amount: money,
  walletId: idString,
  note: z.string().trim().max(300).nullish(),
});
