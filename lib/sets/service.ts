import "server-only";

import { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { withTx, type Db } from "@/lib/db/tx";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { setsAvailable } from "@/lib/sets/pricing";
import type { PackagingLine, SetComponentView, SetDetail, SetListItem } from "@/lib/sets/types";

// ============ Outfit sets (PRD §4.2 — P3.3) ============
//
// A set is built from PRODUCTS, not fixed variants: "Kurti + Dupatta +
// Plazo" is ONE set, and the size and colour of each component is picked
// when it's sold (lib/sets/order-lines.ts). Each component has a quantity
// (units per set), which drives cost, stock and availability everywhere.
// The set's price is its own, independent of the components' prices.

export class SetError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const COMPONENT_INCLUDE = {
  orderBy: { sortOrder: "asc" },
  include: {
    product: {
      select: {
        id: true,
        name: true,
        code: true,
        basePrice: true,
        isActive: true,
        deletedAt: true,
        images: { orderBy: { sortOrder: "asc" }, take: 1, select: { thumbPath: true } },
        variants: {
          where: { isActive: true },
          orderBy: [{ size: { sortOrder: "asc" } }, { color: { sortOrder: "asc" } }],
          select: {
            id: true,
            sku: true,
            stockQty: true,
            reservedQty: true,
            priceOverride: true,
            weightedAvgCost: true,
            size: { select: { name: true } },
            color: { select: { name: true, hexCode: true } },
          },
        },
      },
    },
  },
} satisfies Prisma.OutfitSet$componentsArgs;

const PACKAGING_INCLUDE = {
  orderBy: { createdAt: "asc" },
  include: { materialVariant: { select: { id: true, sku: true, stockQty: true, reservedQty: true, product: { select: { name: true } }, size: { select: { name: true } }, color: { select: { name: true } } } } },
} satisfies Prisma.OutfitSet$packagingArgs;

type ComponentRow = Prisma.OutfitSetComponentGetPayload<{ include: (typeof COMPONENT_INCLUDE)["include"] }>;
type PackagingRow = Prisma.PackagingComponentGetPayload<{ include: (typeof PACKAGING_INCLUDE)["include"] }>;

/** "Brand bag (Free, White)" — the name staff know a material by. */
export function materialLabel(v: { product: { name: string }; size: { name: string }; color: { name: string } }): string {
  return `${v.product.name} (${v.size.name}, ${v.color.name})`;
}

export function toPackagingLine(p: PackagingRow): PackagingLine {
  return { materialVariantId: p.materialVariantId, label: materialLabel(p.materialVariant), sku: p.materialVariant.sku, qty: p.qty, available: p.materialVariant.stockQty - p.materialVariant.reservedQty };
}

function toComponentView(c: ComponentRow): SetComponentView {
  const variants = c.product.variants.map((v) => ({
    id: v.id,
    sku: v.sku,
    sizeName: v.size.name,
    colorName: v.color.name,
    colorHex: v.color.hexCode,
    available: v.stockQty - v.reservedQty,
    price: (v.priceOverride ?? c.product.basePrice).toFixed(2),
    weightedAvgCost: v.weightedAvgCost.toFixed(2),
  }));
  return {
    id: c.id,
    productId: c.productId,
    productName: c.product.name,
    productCode: c.product.code,
    qty: c.qty,
    listPrice: c.product.basePrice.toFixed(2),
    thumbPath: c.product.images[0]?.thumbPath ?? null,
    variants,
    bestSets: variants.reduce((best, v) => Math.max(best, Math.floor(Math.max(0, v.available) / c.qty)), 0),
  };
}

/** Best availability over all combinations, and the component holding it down. */
function availabilityOf(components: SetComponentView[]): { availableSets: number; limitingProduct: string | null } {
  if (components.length === 0) return { availableSets: 0, limitingProduct: null };
  const availableSets = setsAvailable(components.map((c) => ({ available: c.bestSets * c.qty, qtyPerSet: c.qty })));
  const limiting = components.reduce((min, c) => (c.bestSets < min.bestSets ? c : min), components[0]);
  return { availableSets, limitingProduct: limiting.productName };
}

/** Average cost of one set across each component's sizes and colours (cost roles only). */
function averageCost(components: SetComponentView[]): string {
  let paisa = 0;
  for (const c of components) {
    if (c.variants.length === 0) continue;
    const avg = c.variants.reduce((a, v) => a + toPaisa(v.weightedAvgCost ?? "0"), 0) / c.variants.length;
    paisa += Math.round(avg) * c.qty;
  }
  return fromPaisa(paisa);
}

export async function getSetDetail(db: Db, id: string): Promise<SetDetail | null> {
  const set = await db.outfitSet.findFirst({ where: { id, deletedAt: null }, include: { components: COMPONENT_INCLUDE, packaging: PACKAGING_INCLUDE } });
  if (!set) return null;
  const components = set.components.map(toComponentView);
  return {
    id: set.id,
    name: set.name,
    description: set.description,
    price: set.price.toFixed(2),
    isActive: set.isActive,
    components,
    packaging: set.packaging.map(toPackagingLine),
    ...availabilityOf(components),
    cost: averageCost(components),
  };
}

export async function listSets(db: Db, opts: { q?: string; activeOnly?: boolean; take?: number } = {}): Promise<SetListItem[]> {
  const where: Prisma.OutfitSetWhereInput = {
    deletedAt: null,
    ...(opts.activeOnly ? { isActive: true } : {}),
    ...(opts.q ? { name: { contains: opts.q, mode: "insensitive" } } : {}),
  };
  const sets = await db.outfitSet.findMany({ where, orderBy: { name: "asc" }, take: opts.take, include: { components: COMPONENT_INCLUDE } });
  return sets.map((s) => {
    const components = s.components.map(toComponentView);
    return {
      id: s.id,
      name: s.name,
      price: s.price.toFixed(2),
      isActive: s.isActive,
      components: components.map((c) => ({ productName: c.productName, qty: c.qty })),
      ...availabilityOf(components),
    };
  });
}

/** PRD §4.2 — the outfit-set availability report, naming the component that limits each set. */
export type SetAvailabilityRow = {
  id: string;
  name: string;
  isActive: boolean;
  availableSets: number;
  limitingProduct: string | null;
  components: { productName: string; qty: number; bestSets: number; bestVariant: string | null; bestAvailable: number }[];
};

export async function getSetAvailabilityReport(db: Db): Promise<SetAvailabilityRow[]> {
  const sets = await db.outfitSet.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" }, include: { components: COMPONENT_INCLUDE } });
  return sets
    .map((s) => {
      const components = s.components.map(toComponentView);
      return {
        id: s.id,
        name: s.name,
        isActive: s.isActive,
        ...availabilityOf(components),
        components: components.map((c) => {
          const best = c.variants.reduce<(typeof c.variants)[number] | null>((b, v) => (!b || v.available > b.available ? v : b), null);
          return { productName: c.productName, qty: c.qty, bestSets: c.bestSets, bestVariant: best ? `${best.sizeName} / ${best.colorName}` : null, bestAvailable: best ? Math.max(0, best.available) : 0 };
        }),
      };
    })
    .sort((a, b) => a.availableSets - b.availableSets || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Create / edit / delete
// ---------------------------------------------------------------------------

export type SetInput = {
  name: string;
  description?: string | null;
  price: number;
  isActive: boolean;
  components: { productId: string; qty: number }[];
  packaging: { materialVariantId: string; qty: number }[];
};

async function validateComponents(tx: Prisma.TransactionClient, input: SetInput) {
  if (input.components.length < 2) throw new SetError("A set needs at least two products.");
  const ids = input.components.map((c) => c.productId);
  if (new Set(ids).size !== ids.length) throw new SetError("Each product can appear only once — raise its quantity instead.");
  const products = await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, kind: true, deletedAt: true, isActive: true } });
  for (const id of ids) {
    const p = products.find((x) => x.id === id);
    if (!p || p.deletedAt) throw new SetError("One of the products is no longer in the catalog.");
    if (p.kind !== "SELLABLE") throw new SetError(`${p.name} is packaging material — add it under Packaging, not as a component.`);
  }
  await validatePackaging(tx, input.packaging);
}

/** Packaging must be variants of COMPONENT_ONLY products, each once. */
export async function validatePackaging(tx: Prisma.TransactionClient, packaging: { materialVariantId: string; qty: number }[]) {
  const ids = packaging.map((p) => p.materialVariantId);
  if (new Set(ids).size !== ids.length) throw new SetError("Each packaging material can appear only once — raise its quantity instead.");
  if (ids.length === 0) return;
  const variants = await tx.productVariant.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, product: { select: { kind: true, deletedAt: true } } } });
  for (const id of ids) {
    const v = variants.find((x) => x.id === id);
    if (!v || v.product.deletedAt) throw new SetError("One of the packaging materials is no longer in the catalog.");
    if (v.product.kind !== "COMPONENT_ONLY") throw new SetError(`${v.sku} is a product for sale, not packaging material.`);
  }
}

export async function saveSet(db: Db, actorId: string, input: SetInput, id?: string, request?: Request): Promise<{ id: string }> {
  const name = input.name.trim();
  if (!name) throw new SetError("Give the set a name.");
  return withTx(db, async (tx) => {
    await validateComponents(tx, input);
    const before = id ? await tx.outfitSet.findFirst({ where: { id, deletedAt: null }, include: { components: true, packaging: true } }) : null;
    if (id && !before) throw new SetError("Set not found", 404);
    const data = { name, description: input.description?.trim() || null, price: input.price, isActive: input.isActive };
    const set = id ? await tx.outfitSet.update({ where: { id }, data, select: { id: true } }) : await tx.outfitSet.create({ data: { ...data, createdById: actorId }, select: { id: true } });
    await tx.outfitSetComponent.deleteMany({ where: { setId: set.id } });
    await tx.outfitSetComponent.createMany({ data: input.components.map((c, i) => ({ setId: set.id, productId: c.productId, qty: c.qty, sortOrder: i })) });
    await tx.packagingComponent.deleteMany({ where: { outfitSetId: set.id } });
    if (input.packaging.length > 0) await tx.packagingComponent.createMany({ data: input.packaging.map((p) => ({ outfitSetId: set.id, materialVariantId: p.materialVariantId, qty: p.qty })) });
    await writeAuditLogWith(tx, {
      actorId,
      action: id ? "catalog.set.update" : "catalog.set.create",
      entityType: "outfit_set",
      entityId: set.id,
      before: before
        ? { name: before.name, price: before.price.toFixed(2), isActive: before.isActive, components: before.components.map((c) => ({ productId: c.productId, qty: c.qty })), packaging: before.packaging.map((p) => ({ materialVariantId: p.materialVariantId, qty: p.qty })) }
        : undefined,
      after: { ...data, price: input.price.toFixed(2), components: input.components, packaging: input.packaging },
      request,
    });
    return set;
  });
}

export async function deleteSet(db: Db, actorId: string, id: string, request?: Request) {
  return withTx(db, async (tx) => {
    const set = await tx.outfitSet.findFirst({ where: { id, deletedAt: null }, select: { id: true, name: true } });
    if (!set) throw new SetError("Set not found", 404);
    await tx.outfitSet.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    await writeAuditLogWith(tx, { actorId, action: "catalog.set.delete", entityType: "outfit_set", entityId: id, before: { name: set.name }, request });
  });
}
