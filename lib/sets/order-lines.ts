import "server-only";

import type { Prisma } from "@prisma/client";

import type { Db } from "@/lib/db/tx";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { formatBDT, toNumber } from "@/lib/money";
import { isPriceBelowFloor } from "@/lib/orders/price-floor";
import { priceSetComponents } from "@/lib/sets/pricing";
import { SetError } from "@/lib/sets/service";
import type { SetLineInput } from "@/lib/sets/types";

// P3.3 — an outfit set on an order (online, POS, and an order edit). The
// set arrives with a size/colour chosen for each component product; it is
// checked here against the set as it stands now and exploded into ordinary
// order lines — one per component, the chosen variant, units = units per
// set × sets sold, with its share of the set price (lib/sets/pricing.ts).
// Those lines are what gets reserved, deducted, packed, costed and returned,
// exactly like any other line.

export type ResolvedSetChild = {
  variantId: string;
  sku: string;
  productId: string;
  qty: number;
  unitPrice: number;
  lineDiscount: number;
};

export type ResolvedSetLine = {
  setId: string;
  name: string;
  qty: number;
  unitPrice: number;
  lineDiscount: number;
  stockOverrideReason: string | null;
  children: ResolvedSetChild[];
};

export async function resolveSetLines(db: Db | Prisma.TransactionClient, inputs: SetLineInput[], opts: { hasCostAccess: boolean }): Promise<ResolvedSetLine[]> {
  if (inputs.length === 0) return [];
  const setIds = [...new Set(inputs.map((i) => i.setId))];
  const sets = await db.outfitSet.findMany({
    where: { id: { in: setIds } },
    include: {
      components: {
        orderBy: { sortOrder: "asc" },
        include: { product: { select: { id: true, name: true, kind: true, isActive: true, deletedAt: true, basePrice: true } } },
      },
    },
  });
  const variantIds = [...new Set(inputs.flatMap((i) => i.choices.map((c) => c.variantId)))];
  const variants = await db.productVariant.findMany({
    where: { id: { in: variantIds } },
    select: { id: true, sku: true, productId: true, isActive: true, priceOverride: true, weightedAvgCost: true },
  });

  return inputs.map((input) => {
    const set = sets.find((s) => s.id === input.setId);
    if (!set || set.deletedAt || !set.isActive) throw new SetError(`${set?.name ?? "An outfit set"} is no longer for sale.`);
    if (!Number.isInteger(input.qty) || input.qty < 1) throw new SetError(`${set.name}: enter how many sets.`);
    const unitPricePaisa = toPaisa(input.unitPrice);
    const discountPaisa = toPaisa(input.lineDiscount);
    if (unitPricePaisa < 0 || discountPaisa < 0) throw new SetError(`${set.name}: the price and discount can't be negative.`);
    if (discountPaisa > unitPricePaisa * input.qty) throw new SetError(`${set.name}: the discount can't be more than the line.`);

    let costPerSetPaisa = 0;
    const chosen = set.components.map((component) => {
      const choice = input.choices.find((c) => c.productId === component.productId);
      if (!choice) throw new SetError(`${set.name}: pick a size and colour for ${component.product.name}.`);
      const variant = variants.find((v) => v.id === choice.variantId);
      if (!variant || variant.productId !== component.productId) throw new SetError(`${set.name}: that size/colour isn't one of ${component.product.name}'s.`);
      if (!variant.isActive || !component.product.isActive || component.product.deletedAt || component.product.kind !== "SELLABLE") {
        throw new SetError(`${set.name}: ${component.product.name} (${variant.sku}) is no longer for sale.`);
      }
      costPerSetPaisa += toPaisa(variant.weightedAvgCost) * component.qty;
      return { component, variant };
    });
    if (input.choices.length !== set.components.length) throw new SetError(`${set.name}: the set has changed — pick its sizes and colours again.`);

    // PRD §4.6 price floor, on the set as a whole: its price against the
    // cost of the combination actually chosen.
    if (isPriceBelowFloor(input.unitPrice, costPerSetPaisa / 100, opts.hasCostAccess)) {
      throw new SetError(`The price for ${set.name} is below the minimum allowed. Raise it, or ask a Manager/Admin.`);
    }

    const priced = priceSetComponents({
      unitPricePaisa,
      qty: input.qty,
      discountPaisa,
      components: chosen.map(({ component, variant }) => ({ key: component.productId, qtyPerSet: component.qty, listPricePaisa: toPaisa(variant.priceOverride ?? component.product.basePrice) })),
    });
    return {
      setId: set.id,
      name: set.name,
      qty: input.qty,
      unitPrice: unitPricePaisa / 100,
      lineDiscount: discountPaisa / 100,
      stockOverrideReason: input.stockOverrideReason?.trim() || null,
      children: chosen.map(({ component, variant }, i) => ({
        variantId: variant.id,
        sku: variant.sku,
        productId: component.productId,
        qty: priced[i].qty,
        unitPrice: priced[i].unitPricePaisa / 100,
        lineDiscount: priced[i].discountPaisa / 100,
      })),
    };
  });
}

/**
 * Writes the set lines and their component lines on an order. Returns the
 * component lines created (for the caller to reserve or deduct, as it does
 * for any line). `unitCostSnapshot` freezes cost now (a POS sale).
 */
export async function writeSetLines(
  tx: Prisma.TransactionClient,
  orderId: string,
  lines: ResolvedSetLine[],
  opts: { costByVariant?: Map<string, Prisma.Decimal>; overrideByVariant?: Map<string, string> } = {},
): Promise<{ id: string; variantId: string; qty: number; setLineId: string }[]> {
  const created: { id: string; variantId: string; qty: number; setLineId: string }[] = [];
  for (const line of lines) {
    const setLine = await tx.orderSetLine.create({
      data: { orderId, outfitSetId: line.setId, name: line.name, qty: line.qty, unitPrice: line.unitPrice, lineDiscount: line.lineDiscount },
      select: { id: true },
    });
    for (const child of line.children) {
      const override = opts.overrideByVariant?.get(child.variantId) ?? null;
      const item = await tx.orderItem.create({
        data: {
          orderId,
          setLineId: setLine.id,
          variantId: child.variantId,
          qty: child.qty,
          unitPrice: child.unitPrice,
          lineDiscount: child.lineDiscount,
          unitCostSnapshot: opts.costByVariant?.get(child.variantId) ?? null,
          stockOverride: override !== null,
          stockOverrideReason: override,
        },
        select: { id: true, variantId: true, qty: true },
      });
      created.push({ ...item, setLineId: setLine.id });
    }
  }
  return created;
}

/** A set line's total, for audit rows and messages. */
export function setLineTotal(line: { unitPrice: number; qty: number; lineDiscount: number }): string {
  return fromPaisa(toPaisa(line.unitPrice) * line.qty - toPaisa(line.lineDiscount));
}

export const setLineLabel = (line: { name: string; qty: number; unitPrice: number | Prisma.Decimal }) => `${line.qty} × ${line.name} @ ${formatBDT(toNumber(line.unitPrice))}`;
