import "server-only";

import { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { withTx, type Db } from "@/lib/db/tx";
import { buildVariantSku, productCodeAlternatives, SKU_MAX_LENGTH, suggestColorCode, suggestProductCode, suggestSizeCode } from "@/lib/catalog/codes";
import { SKU_PATTERN } from "@/lib/barcode/scan";

// PRD §4.2 — SKU = product code + size code + colour code (lib/catalog/codes.ts),
// at most 9 characters. A variant's SKU is regenerated whenever a code it's
// built from changes — until its first price tag is printed. From then on it
// is locked (tagPrintedAt; a DB trigger refuses any change), and the codes
// behind it can't change either.
//
// No separators means different codes can join into the same SKU:
// K1 + 23 + MRN and K12 + 3 + MRN are both K123MRN (numeric sizes make it
// real). The unique index on sku is the backstop; everything here checks the
// whole set of SKUs a change would produce before writing any of them, so
// staff get a sentence, not a database error.

export class SkuError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

async function taken(db: Db, model: "product" | "color" | "size"): Promise<Set<string>> {
  const rows =
    model === "product"
      ? await db.product.findMany({ select: { code: true } })
      : model === "color"
        ? await db.color.findMany({ select: { code: true } })
        : await db.size.findMany({ select: { code: true } });
  return new Set(rows.map((r) => r.code));
}

export async function generateProductCode(db: Db, name: string): Promise<string> {
  const code = suggestProductCode(name, await taken(db, "product"));
  if (!code) throw new SkuError("Couldn't suggest a free product code — type one in.", 400);
  return code;
}

export async function generateColorCode(db: Db, name: string): Promise<string> {
  const code = suggestColorCode(name, await taken(db, "color"));
  if (!code) throw new SkuError("Couldn't suggest a free colour code — type one in.", 400);
  return code;
}

export async function generateSizeCode(db: Db, name: string): Promise<string> {
  const code = suggestSizeCode(name, await taken(db, "size"));
  if (!code) throw new SkuError("Couldn't suggest a free size code — type one in.", 400);
  return code;
}

/** The SKU for a new variant, refused if it's over the cap or another variant already has it. */
export async function skuForNewVariant(db: Db, productCode: string, sizeCode: string, colorCode: string): Promise<string> {
  const sku = buildVariantSku(productCode, sizeCode, colorCode);
  assertSkuShape(sku);
  const clash = await findSkuOwner(db, [sku]);
  if (clash) throw new SkuError(`${describeOwner(clash)} — change this product's or the colour's code.`);
  return sku;
}

const OWNER_SELECT = {
  id: true,
  sku: true,
  productId: true,
  product: { select: { name: true, code: true } },
  size: { select: { name: true } },
  color: { select: { name: true } },
} satisfies Prisma.ProductVariantSelect;

type SkuOwner = Prisma.ProductVariantGetPayload<{ select: typeof OWNER_SELECT }>;

/** The first existing variant (outside `exceptProductId`, if given) that already has one of `skus`. */
async function findSkuOwner(db: Db, skus: string[], exceptProductId?: string): Promise<SkuOwner | null> {
  if (skus.length === 0) return null;
  return db.productVariant.findFirst({
    where: { sku: { in: skus }, ...(exceptProductId ? { productId: { not: exceptProductId } } : {}) },
    select: OWNER_SELECT,
    orderBy: { sku: "asc" },
  });
}

/** "SKU K123MRN is already used by Kurti 12 (K12 · size 3 · Maroon)" */
function describeOwner(owner: SkuOwner): string {
  return `SKU ${owner.sku} is already used by ${owner.product.name} (${owner.product.code} · size ${owner.size.name} · ${owner.color.name})`;
}

type SkuLine = { label: string; sizeCode: string; colorCode: string };

/**
 * Two size/colour pairs of one product that join into the same SKU (size X +
 * LRD and size XL + RD are both …XLRD). No product code can fix that.
 */
function sameSkuWithinProduct(productCode: string, lines: SkuLine[]): string | null {
  const seen = new Map<string, string>();
  for (const line of lines) {
    const sku = buildVariantSku(productCode, line.sizeCode, line.colorCode);
    const other = seen.get(sku);
    if (other) return `${other} and ${line.label} would both be SKU ${sku} — give one of those sizes or colours a different code.`;
    seen.set(sku, line.label);
  }
  return null;
}

const lineLabel = (size: { name: string; code: string }, color: { name: string; code: string }) =>
  `size ${size.name} (${size.code}) + ${color.name} (${color.code})`;

export type GenerateVariantsResult = {
  created: string[];
  /** Set when this product's code moved to keep its SKUs unique. */
  codeChange: { from: string; to: string } | null;
  /** What staff are told when the code moved. */
  notice: string | null;
};

/**
 * PRD §4.2 variant matrix: creates every size × colour pair the product
 * doesn't have yet. Before writing, it checks the SKUs of all the product's
 * variants — old and new — against every other product. If one would clash
 * (K1 + 23 + MRN vs K12 + 3 + MRN) and none of this product's tags are
 * printed, the product moves to the next free code that avoids every clash
 * and its existing SKUs are rebuilt with it, all in one transaction, audited.
 */
export async function generateVariants(
  db: Db,
  input: {
    productId: string;
    sizes: { id: string; name: string; code: string }[];
    colors: { id: string; name: string; code: string }[];
    actorId: string | null;
    request?: Request;
  },
): Promise<GenerateVariantsResult> {
  return withTx(db, async (tx) => {
    const product = await tx.product.findUniqueOrThrow({ where: { id: input.productId }, select: { id: true, name: true, code: true } });
    const existing = await tx.productVariant.findMany({
      where: { productId: product.id },
      select: { sizeId: true, colorId: true, tagPrintedAt: true, size: { select: { name: true, code: true } }, color: { select: { name: true, code: true } } },
    });
    const have = new Set(existing.map((v) => `${v.sizeId}:${v.colorId}`));
    const fresh = input.sizes.flatMap((size) =>
      input.colors.filter((color) => !have.has(`${size.id}:${color.id}`)).map((color) => ({ size, color, label: lineLabel(size, color), sizeCode: size.code, colorCode: color.code })),
    );
    if (fresh.length === 0) return { created: [], codeChange: null, notice: null };

    const lines: SkuLine[] = [...existing.map((v) => ({ label: lineLabel(v.size, v.color), sizeCode: v.size.code, colorCode: v.color.code })), ...fresh];
    const inner = sameSkuWithinProduct(product.code, lines);
    if (inner) throw new SkuError(inner);
    for (const line of fresh) assertSkuShape(buildVariantSku(product.code, line.sizeCode, line.colorCode));

    // New SKUs must be free everywhere (a hand-typed SKU on this product too).
    // Under a new code the existing variants are rebuilt as well, so theirs
    // must be free on every other product.
    const clashFor = async (code: string, rebuildExisting: boolean) =>
      (await findSkuOwner(tx, fresh.map((l) => buildVariantSku(code, l.sizeCode, l.colorCode)))) ??
      (rebuildExisting ? await findSkuOwner(tx, lines.map((l) => buildVariantSku(code, l.sizeCode, l.colorCode)), product.id) : null);

    let code = product.code;
    let codeChange: GenerateVariantsResult["codeChange"] = null;
    let notice: string | null = null;
    const clash = await clashFor(code, false);
    if (clash) {
      const what = describeOwner(clash);
      if (existing.some((v) => v.tagPrintedAt)) {
        throw new SkuError(`${what}. Price tags are already printed for ${product.name}, so its code ${code} can't move — give that size or colour a different code.`);
      }
      const taken = new Set((await tx.product.findMany({ select: { code: true } })).map((p) => p.code));
      let free: string | null = null;
      for (const candidate of productCodeAlternatives(code, product.name)) {
        if (taken.has(candidate)) continue;
        if (!(await clashFor(candidate, true))) {
          free = candidate;
          break;
        }
      }
      if (!free) throw new SkuError(`${what}, and no free product code avoids it — type a new code for ${product.name}.`);

      await tx.product.update({ where: { id: product.id }, data: { code: free } });
      const skuChanges = await regenerateSkus(tx, { productId: product.id });
      codeChange = { from: code, to: free };
      notice = `${what}, so ${product.name}'s code changed from ${code} to ${free} to keep every SKU unique.`;
      await writeAuditLogWith(tx, {
        actorId: input.actorId,
        action: "catalog.product.code_auto_change",
        entityType: "product",
        entityId: product.id,
        before: { code },
        after: { code: free, reason: what, skuChanges },
        request: input.request,
      });
      code = free;
    }

    const created = fresh.map((line) => ({ productId: product.id, sizeId: line.size.id, colorId: line.color.id, sku: buildVariantSku(code, line.sizeCode, line.colorCode) }));
    await tx.productVariant.createMany({ data: created });
    await writeAuditLogWith(tx, {
      actorId: input.actorId,
      action: "catalog.variant.generate",
      entityType: "product",
      entityId: product.id,
      after: { created: created.map((c) => c.sku), ...(codeChange ? { codeChange } : {}) },
      request: input.request,
    });
    return { created: created.map((c) => c.sku), codeChange, notice };
  });
}

/** The unique index on sku (or on a code) fired: two saves raced past the checks above. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export const RACE_MESSAGE = "Someone else changed the catalog at the same moment and a SKU would have been used twice. Nothing was saved — try again.";

export function assertSkuShape(sku: string): void {
  if (sku.length > SKU_MAX_LENGTH) throw new SkuError(`SKU ${sku} is ${sku.length} characters — at most ${SKU_MAX_LENGTH} scan reliably on a 38 mm tag. Shorten the codes.`, 400);
  if (!SKU_PATTERN.test(sku)) throw new SkuError(`SKU ${sku} may only use capital letters and digits.`, 400);
}

/** Variants whose SKU is already on a printed tag — a code behind them can't change. */
export async function countLockedVariants(db: Db, where: Prisma.ProductVariantWhereInput): Promise<number> {
  return db.productVariant.count({ where: { ...where, tagPrintedAt: { not: null } } });
}

/**
 * Rebuilds the SKU of every variant matching `where` from its current codes
 * (after a product/size/colour code changed). Refuses — before writing
 * anything — if one of them is locked, too long, or would collide.
 * Returns [old, new] pairs for the audit log.
 */
export async function regenerateSkus(tx: Prisma.TransactionClient, where: Prisma.ProductVariantWhereInput): Promise<[string, string][]> {
  const rows = await tx.productVariant.findMany({
    where,
    select: { id: true, sku: true, tagPrintedAt: true, product: { select: { code: true, name: true } }, size: { select: { code: true, name: true } }, color: { select: { code: true, name: true } } },
  });
  const locked = rows.filter((r) => r.tagPrintedAt);
  if (locked.length > 0) {
    throw new SkuError(`Tags are already printed for ${locked.length} variant${locked.length === 1 ? "" : "s"} (${locked.slice(0, 3).map((r) => r.sku).join(", ")}${locked.length > 3 ? "…" : ""}) — their SKUs are locked, so this code can't change.`);
  }
  const rebuilt = rows.map((r) => ({ id: r.id, old: r.sku, sku: buildVariantSku(r.product.code, r.size.code, r.color.code), label: `${r.product.name} ${lineLabel(r.size, r.color)}` }));
  const next = rebuilt.filter((r) => r.sku !== r.old);
  for (const r of next) assertSkuShape(r.sku);
  // Within the set (a size code change touches many products): no two may end up the same.
  const bySku = new Map<string, string>();
  for (const r of rebuilt) {
    const other = bySku.get(r.sku);
    if (other) throw new SkuError(`${other} and ${r.label} would both be SKU ${r.sku} — pick a different code.`);
    bySku.set(r.sku, r.label);
  }
  const ids = new Set(rows.map((r) => r.id));
  const clashes = await tx.productVariant.findMany({ where: { sku: { in: next.map((r) => r.sku) } }, select: OWNER_SELECT });
  const clash = clashes.find((c) => !ids.has(c.id));
  if (clash) throw new SkuError(`${describeOwner(clash)} — pick a different code.`);
  for (const r of next) await tx.productVariant.update({ where: { id: r.id }, data: { sku: r.sku } });
  return next.map((r) => [r.old, r.sku]);
}

/**
 * P3.1 — a variant's SKU locks the first time a tag is printed for it.
 * Returns the SKUs that were locked just now (already-locked ones are left alone).
 */
export async function lockSkusForPrintedTags(tx: Prisma.TransactionClient, variantIds: string[]): Promise<{ id: string; sku: string; productId: string }[]> {
  const fresh = await tx.productVariant.findMany({ where: { id: { in: variantIds }, tagPrintedAt: null }, select: { id: true, sku: true, productId: true } });
  if (fresh.length === 0) return [];
  await tx.productVariant.updateMany({ where: { id: { in: fresh.map((v) => v.id) }, tagPrintedAt: null }, data: { tagPrintedAt: new Date(), skuLocked: true } });
  return fresh;
}
