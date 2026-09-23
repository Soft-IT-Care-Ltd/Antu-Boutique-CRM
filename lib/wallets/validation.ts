import { z } from "zod";

import { dayString } from "@/lib/finance/http";
import { WALLET_TYPE_VALUES } from "@/lib/wallets/constants";

export const walletBodySchema = z.object({
  name: z.string().trim().min(2, "Give the wallet a name").max(60),
  type: z.enum(WALLET_TYPE_VALUES),
  accountNo: z.string().trim().max(60).nullish(),
  openingBalance: z.coerce.number().min(-100_000_000).max(100_000_000).default(0),
  openingDate: dayString,
  sortOrder: z.coerce.number().int().min(0).max(1000).optional(),
  note: z.string().trim().max(300).nullish(),
});
