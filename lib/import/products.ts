import "server-only";

import type { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { SKU_PATTERN } from "@/lib/barcode/scan";
import { buildVariantSku, PRODUCT_CODE_PATTERN, SKU_MAX_LENGTH, suggestProductCode } from "@/lib/catalog/codes";
import { recordStockMovement } from "@/lib/inventory/ledger";
import type { CsvTable } from "@/lib/import/csv";
import type { ImportIssue, ImportSummaryItem } from "@/lib/import/types";
import { nameKey, readList, readMoney, readWholeNumber } from "@/lib/import/values";
import { formatBDT } from "@/lib/money";

// PRD §4.2 / §4.3 — products with their size × colour variants and the
// stock on the shelf on the opening day, one sheet row per variant.
//
// Sizes, colours and categories must already be in the Settings masters
// ("Maroon is one value, not five spellings"); a name the masters don't
// know is an error to fix, never a new master row. Opening stock enters the
// ledger exactly as the seed's does: one ADJUSTMENT row referenced
// OPENING_BALANCE, written with the stock change (CLAUDE.md rule 2), at the
// sheet's unit cost, which also becomes the variant's weighted average
// cost. Opening balances post no expense (PRD §4.12). A variant that
// already has any stock history can't be given an opening balance.
//
// The import only adds: an existing product keeps its details and gains
// the sheet's new sizes/colours; an existing variant only takes an opening
// balance (if it has no history yet).

type PlannedVariant = {
  line: number;
  sizeId: string;
  colorId: string;
  label: string;
  sku: string;
  existingId: string | null;
  priceOverride: string | null;
  lowStockThreshold: number | null;
  weightGrams: number | null;
  openingQty: number;
  unitCost: string | null;
};

type PlannedProduct = {
  firstLine: number;
  existingId: string | null;
  code: string;
  name: string;
  kind: "SELLABLE" | "COMPONENT_ONLY";
  categoryId: string | null;
  brand: string | null;
  fabric: string | null;
  description: string | null;
  basePrice: string;
  tags: string[];
  variants: PlannedVariant[];
};

export type ProductPlan = { products: PlannedProduct[]; errors: ImportIssue[]; warnings: ImportIssue[] };

const PRODUCT_FIELDS = ["product_name", "type", "category", "brand", "fabric", "description", "base_price", "tags"] as const;

function readKind(raw: string): "SELLABLE" | "COMPONENT_ONLY" {
  const k = nameKey(raw);
  if (k === "" || k === "sale" || k === "sellable" || k === "for sale") return "SELLABLE";
  if (k === "packaging" || k === "packaging material" || k === "component") return "COMPONENT_ONLY";
  throw new Error(`type "${raw}" — use "sale" or "packaging"`);
}

type Master = { id: string; name: string; code: string; isActive: boolean };

function matchMaster(list: Master[], raw: string, what: string): Master {
  const key = nameKey(raw);
  const hit = list.find((m) => nameKey(m.name) === key) ?? list.find((m) => m.code.toLowerCase() === key);
  if (!hit) throw new Error(`${what} "${raw}" isn't in Settings → Catalog masters — add it there (or fix the spelling) first`);
  if (!hit.isActive) throw new Error(`${what} "${hit.name}" is switched off in Settings → Catalog masters`);
  return hit;
}

export async function planProductImport(db: Prisma.TransactionClient, table: CsvTable): Promise<ProductPlan> {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  for (const col of ["product_name", "size", "colour"]) {
    if (!table.headers.includes(col)) errors.push({ line: null, message: `The sheet needs a "${col}" column` });
  }
  if (errors.length > 0) return { products: [], errors, warnings };

  const [sizes, colors, categories] = await Promise.all([
    db.size.findMany({ select: { id: true, name: true, code: true, isActive: true } }),
    db.color.findMany({ select: { id: true, name: true, code: true, isActive: true } }),
    db.category.findMany({ select: { id: true, name: true, isActive: true } }),
  ]);

  // 1. Group rows into products: by code when given, else by name.
  type Group = { key: string; code: string | null; rows: CsvTable["rows"] };
  const groups = new Map<string, Group>();
  const nameToCode = new Map<string, string>();
  for (const row of table.rows) {
    const code = (row.values.product_code ?? "").toUpperCase();
    const name = row.values.product_name ?? "";
    if (!name) {
      errors.push({ line: row.line, message: "product_name is blank" });
      continue;
    }
    if (code && !PRODUCT_CODE_PATTERN.test(code)) {
      errors.push({ line: row.line, message: `product_code "${row.values.product_code}" — 2–3 capital letters or digits (e.g. K12)` });
      continue;
    }
    // A name that appears with a code on one row and without on another is still one product.
    if (code) nameToCode.set(nameKey(name), code);
    const key = code ? `code:${code}` : `name:${nameKey(name)}`;
    const group = groups.get(key) ?? { key, code: code || null, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    if (group.code) continue;
    const code = nameToCode.get(key.slice(5));
    if (code) {
      groups.get(`code:${code}`)!.rows.push(...group.rows);
      groups.delete(key);
    }
  }

  // 2. What already exists.
  const codes = [...groups.values()].map((g) => g.code).filter((c): c is string => Boolean(c));
  const names = [...groups.values()].filter((g) => !g.code).map((g) => g.rows[0].values.product_name);
  const existingProducts = await db.product.findMany({
    where: { OR: [{ code: { in: codes } }, ...names.map((n) => ({ name: { equals: n.trim(), mode: "insensitive" as const } }))] },
    select: {
      id: true,
      code: true,
      name: true,
      deletedAt: true,
      variants: { select: { id: true, sizeId: true, colorId: true, sku: true, _count: { select: { stockMovements: true } } } },
    },
  });
  const takenCodes = new Set((await db.product.findMany({ select: { code: true } })).map((p) => p.code));

  // 3. Each product.
  const products: PlannedProduct[] = [];
  for (const group of groups.values()) {
    const first = group.rows[0];
    const lineErrors = (line: number, message: string) => errors.push({ line, message });

    // Product-level cells must agree on every row that fills them.
    const value: Partial<Record<(typeof PRODUCT_FIELDS)[number], string>> = {};
    for (const row of group.rows) {
      for (const field of PRODUCT_FIELDS) {
        const v = row.values[field] ?? "";
        if (!v) continue;
        if (value[field] === undefined) value[field] = v;
        else if (field === "product_name" ? nameKey(value[field]!) !== nameKey(v) : value[field] !== v) {
          lineErrors(row.line, `${field} "${v}" differs from "${value[field]}" on an earlier row of the same product`);
        }
      }
    }

    const byCode = group.code ? existingProducts.filter((p) => p.code === group.code) : [];
    const byName = group.code ? [] : existingProducts.filter((p) => nameKey(p.name) === nameKey(first.values.product_name));
    const matches = byCode.length > 0 ? byCode : byName;
    if (matches.length > 1) {
      lineErrors(first.line, `${matches.length} products are already called "${first.values.product_name}" — add a product_code column to say which one`);
      continue;
    }
    const existing = matches[0] ?? null;
    if (existing?.deletedAt) {
      lineErrors(first.line, `Product ${existing.code} (${existing.name}) is in the Trash — restore it first, or use another code`);
      continue;
    }

    let kind: PlannedProduct["kind"] = "SELLABLE";
    let categoryId: string | null = null;
    let basePrice = "0.00";
    try {
      kind = readKind(value.type ?? "");
      if (value.category) {
        const key = nameKey(value.category);
        const category = categories.find((c) => nameKey(c.name) === key);
        if (!category) throw new Error(`category "${value.category}" isn't in Settings → Catalog masters — add it there first`);
        if (!category.isActive) throw new Error(`category "${category.name}" is switched off in Settings`);
        categoryId = category.id;
      }
      const price = readMoney(value.base_price, "base_price");
      if (kind === "COMPONENT_ONLY") {
        if (price !== null && Number(price) !== 0) throw new Error("Packaging material has no selling price — leave base_price blank");
      } else if (!existing) {
        if (price === null) throw new Error("base_price is required for a new product for sale");
        basePrice = price;
      }
    } catch (e) {
      lineErrors(first.line, (e as Error).message);
      continue;
    }
    if (existing) warnings.push({ line: first.line, message: `${existing.code} ${existing.name} already exists — its details are kept; only new sizes/colours and opening stock are imported` });

    const planned: PlannedProduct = {
      firstLine: first.line,
      existingId: existing?.id ?? null,
      code: existing?.code ?? group.code ?? "",
      name: existing?.name ?? first.values.product_name.trim(),
      kind,
      categoryId,
      brand: value.brand || null,
      fabric: value.fabric || null,
      description: value.description || null,
      basePrice,
      tags: [...new Set(readList(value.tags))].slice(0, 20),
      variants: [],
    };

    const seenPairs = new Set<string>();
    for (const row of group.rows) {
      try {
        const size = matchMaster(sizes, row.values.size ?? "", "size");
        const color = matchMaster(colors, row.values.colour ?? "", "colour");
        const pair = `${size.id}:${color.id}`;
        if (seenPairs.has(pair)) throw new Error(`${size.name} / ${color.name} appears twice for this product`);
        seenPairs.add(pair);
        const priceOverride = readMoney(row.values.price_override, "price_override");
        if (kind === "COMPONENT_ONLY" && priceOverride !== null) throw new Error("Packaging material has no selling price — leave price_override blank");
        const openingQty = readWholeNumber(row.values.opening_qty, "opening_qty", { min: 0, max: 100_000 }) ?? 0;
        const unitCost = readMoney(row.values.unit_cost, "unit_cost");
        if (openingQty > 0 && unitCost === null) throw new Error("unit_cost is required with an opening_qty — it becomes the variant's cost");
        const sku = (row.values.sku ?? "").toUpperCase();
        if (sku && !SKU_PATTERN.test(sku)) throw new Error(`sku "${row.values.sku}" — at most ${SKU_MAX_LENGTH} capital letters and digits`);
        const existingVariant = existing?.variants.find((v) => v.sizeId === size.id && v.colorId === color.id) ?? null;
        if (existingVariant && openingQty > 0 && existingVariant._count.stockMovements > 0) {
          throw new Error(`${existingVariant.sku} already has stock history — record a purchase or a stock adjustment instead of an opening balance`);
        }
        if (existingVariant && openingQty === 0) warnings.push({ line: row.line, message: `${existingVariant.sku} already exists — nothing to import on this row` });
        planned.variants.push({
          line: row.line,
          sizeId: size.id,
          colorId: color.id,
          label: `${size.name} / ${color.name}`,
          // Resolved once the product's code is final (step 4).
          sku: existingVariant?.sku ?? (sku || `\u0000${size.code}\u0000${color.code}`),
          existingId: existingVariant?.id ?? null,
          priceOverride,
          lowStockThreshold: readWholeNumber(row.values.low_stock_threshold, "low_stock_threshold", { min: 0, max: 1000 }),
          weightGrams: readWholeNumber(row.values.weight_grams, "weight_grams", { min: 1, max: 50_000 }),
          openingQty,
          unitCost,
        });
      } catch (e) {
        lineErrors(row.line, (e as Error).message);
      }
    }
    products.push(planned);
  }

  // 4. Codes and SKUs: a new product without a code gets the first suggested
  // code whose SKUs are free everywhere; a typed code must be free already.
  const batchCodes = new Set<string>();
  const allSkus = new Map<string, number>();
  const skusOf = (p: PlannedProduct, code: string) =>
    p.variants.map((v) => {
      if (!v.sku.startsWith("\u0000")) return v.sku;
      const [, sizeCode, colorCode] = v.sku.split("\u0000");
      return buildVariantSku(code, sizeCode, colorCode);
    });
  const dbSkuOwners = async (skus: string[], productId: string | null) =>
    db.productVariant.findMany({ where: { sku: { in: skus }, ...(productId ? { productId: { not: productId } } : {}) }, select: { sku: true, product: { select: { name: true } } } });

  for (const p of products) {
    if (!p.existingId && p.code) {
      if (takenCodes.has(p.code) || batchCodes.has(p.code)) {
        errors.push({ line: p.firstLine, message: `product_code ${p.code} is already used by another product` });
        continue;
      }
    }
    if (!p.code) {
      const rejected = new Set([...takenCodes, ...batchCodes]);
      for (let attempt = 0; attempt < 30; attempt++) {
        const candidate = suggestProductCode(p.name, rejected);
        if (!candidate) break;
        const skus = skusOf(p, candidate);
        if (skus.every((s) => s.length <= SKU_MAX_LENGTH && !allSkus.has(s)) && (await dbSkuOwners(skus, null)).length === 0) {
          p.code = candidate;
          break;
        }
        rejected.add(candidate);
      }
      if (!p.code) {
        errors.push({ line: p.firstLine, message: `Couldn't find a free product code for "${p.name}" — add a product_code` });
        continue;
      }
    }
    batchCodes.add(p.code);
    const skus = skusOf(p, p.code);
    p.variants.forEach((v, i) => {
      v.sku = skus[i];
    });
    for (const v of p.variants) {
      if (v.existingId) continue;
      if (v.sku.length > SKU_MAX_LENGTH) errors.push({ line: v.line, message: `SKU ${v.sku} is ${v.sku.length} characters — at most ${SKU_MAX_LENGTH} scan on a 38 mm tag. Use a shorter product code or type a sku` });
      const other = allSkus.get(v.sku);
      if (other !== undefined) errors.push({ line: v.line, message: `SKU ${v.sku} is also made by row ${other}` });
      allSkus.set(v.sku, v.line);
    }
    for (const owner of await dbSkuOwners(p.variants.filter((v) => !v.existingId).map((v) => v.sku), p.existingId)) {
      const v = p.variants.find((x) => x.sku === owner.sku)!;
      errors.push({ line: v.line, message: `SKU ${owner.sku} is already used by ${owner.product.name} — type another sku or product_code` });
    }
  }

  errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return { products, errors, warnings };
}

export function summarizeProductPlan(plan: ProductPlan): { summary: ImportSummaryItem[]; preview: { line: number; text: string }[] } {
  const variants = plan.products.flatMap((p) => p.variants);
  const units = variants.reduce((n, v) => n + v.openingQty, 0);
  const valuePaisa = variants.reduce((n, v) => n + v.openingQty * Math.round(Number(v.unitCost ?? 0) * 100), 0);
  return {
    summary: [
      { label: "New products", value: String(plan.products.filter((p) => !p.existingId).length) },
      { label: "Existing products", value: String(plan.products.filter((p) => p.existingId).length) },
      { label: "New variants", value: String(variants.filter((v) => !v.existingId).length) },
      { label: "Opening stock", value: `${units} units` },
      { label: "Opening stock at cost", value: formatBDT(valuePaisa / 100) },
    ],
    preview: variants.map((v) => {
      const p = plan.products.find((x) => x.variants.includes(v))!;
      return {
        line: v.line,
        text: `${v.existingId ? "" : "New "}${v.sku} — ${p.name} ${v.label}${v.openingQty > 0 ? ` · opening ${v.openingQty} @ ${formatBDT(v.unitCost ?? 0)}` : ""}`,
      };
    }),
  };
}

export async function applyProductPlan(tx: Prisma.TransactionClient, plan: ProductPlan, actorId: string, request?: Request): Promise<void> {
  for (const p of plan.products) {
    const productId =
      p.existingId ??
      (
        await tx.product.create({
          data: { code: p.code, name: p.name, kind: p.kind, categoryId: p.categoryId, brand: p.brand, fabric: p.fabric, description: p.description, basePrice: p.basePrice, tags: p.tags, createdById: actorId },
          select: { id: true },
        })
      ).id;

    for (const v of p.variants) {
      let variantId = v.existingId;
      if (!variantId) {
        const created = await tx.productVariant.create({
          data: { productId, sizeId: v.sizeId, colorId: v.colorId, sku: v.sku, weightedAvgCost: v.unitCost ?? 0, priceOverride: v.priceOverride, lowStockThreshold: v.lowStockThreshold, weightGrams: v.weightGrams },
          select: { id: true },
        });
        variantId = created.id;
      } else if (v.openingQty > 0) {
        await tx.productVariant.update({ where: { id: variantId }, data: { weightedAvgCost: v.unitCost! } });
      }
      if (v.openingQty > 0) {
        await recordStockMovement(tx, { variantId, type: "ADJUSTMENT", qty: v.openingQty, unitCost: v.unitCost!, referenceType: "OPENING_BALANCE", actorId, note: "Opening stock (import)" });
      }
    }

    await writeAuditLogWith(tx, {
      actorId,
      action: p.existingId ? "import.product_update" : "import.product_create",
      entityType: "product",
      entityId: productId,
      after: {
        code: p.code,
        name: p.name,
        variants: p.variants.map((v) => ({ sku: v.sku, created: !v.existingId, openingQty: v.openingQty, unitCost: v.unitCost })),
      },
      request,
    });
  }
}
