import { z } from "zod";

import { BDT_DENOMINATIONS, denominationTotal, DRAWER_MOVEMENT_KINDS, type Denominations } from "@/lib/pos/constants";

// Zod shapes for the drawer routes (CLAUDE.md rule 9). Client-safe.

const count = z.coerce.number({ error: "Enter the counted cash" }).min(0, "A count can't be negative").max(100_000_000);

const denominations = z
  .object(Object.fromEntries(BDT_DENOMINATIONS.map((d) => [String(d), z.coerce.number().int().min(0).max(100_000).optional()])))
  .strict()
  .nullish();

/** A note-by-note count must add up to the total it claims. */
const withCount = <T extends { denominations?: Denominations | null }>(field: "openingCount" | "closingCount") => (data: T & Record<string, unknown>) =>
  !data.denominations || Math.round(denominationTotal(data.denominations) * 100) === Math.round(Number(data[field]) * 100);

export const openDrawerSchema = z
  .object({ openingCount: count, denominations, note: z.string().trim().max(500).nullish() })
  .refine(withCount("openingCount"), { message: "The notes and coins don't add up to the opening count", path: ["denominations"] });

export const closeDrawerSchema = z
  .object({ drawerId: z.string().trim().min(1).max(50), closingCount: count, denominations, note: z.string().trim().max(500).nullish() })
  .refine(withCount("closingCount"), { message: "The notes and coins don't add up to the counted cash", path: ["denominations"] });

export const drawerMovementSchema = z
  .object({
    kind: z.enum(DRAWER_MOVEMENT_KINDS),
    amount: z.coerce.number({ error: "Enter an amount" }).positive("Enter an amount greater than zero").max(100_000_000),
    note: z.string().trim().min(3, "Say what this cash was for").max(300),
    toWalletId: z.string().trim().min(1).max(50).nullish(),
    categoryId: z.string().trim().min(1).max(50).nullish(),
  })
  .refine((d) => d.kind !== "DEPOSIT" || Boolean(d.toWalletId), { message: "Pick the wallet the cash went to", path: ["toWalletId"] })
  .refine((d) => d.kind !== "EXPENSE" || Boolean(d.categoryId), { message: "Pick what the expense was for", path: ["categoryId"] });
