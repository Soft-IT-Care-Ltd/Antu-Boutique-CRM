import { z } from "zod";

// P3.3 — Zod shapes for outfit sets (CLAUDE.md rule 9). Client-safe.

const id = z.string().cuid();
const money = z.coerce.number().min(0).max(100_000_000);

/** A set sold on an order or at the POS, with the size/colour picked for each component product. */
export const setLineSchema = z.object({
  setId: id,
  qty: z.coerce.number().int().min(1).max(999),
  unitPrice: money,
  lineDiscount: money.default(0),
  choices: z.array(z.object({ productId: id, variantId: id })).min(1).max(20),
  stockOverrideReason: z.string().trim().max(300).nullish(),
});

export const setInputSchema = z.object({
  name: z.string().trim().min(1, "Give the set a name").max(200),
  description: z.string().trim().max(2000).nullish(),
  price: z.coerce.number({ error: "Enter the set's price" }).min(0).max(10_000_000),
  isActive: z.boolean().default(true),
  components: z
    .array(z.object({ productId: id, qty: z.coerce.number().int().min(1, "At least 1").max(99) }))
    .min(2, "A set needs at least two products")
    .max(20),
  packaging: z.array(z.object({ materialVariantId: id, qty: z.coerce.number().int().min(1).max(99) })).max(20).default([]),
});

export const packagingListSchema = z.array(z.object({ materialVariantId: id, qty: z.coerce.number().int().min(1).max(99) })).max(20);
