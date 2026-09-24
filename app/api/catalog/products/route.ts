import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { PRODUCT_CODE_MESSAGE, PRODUCT_CODE_PATTERN } from "@/lib/catalog/codes";
import { generateProductCode } from "@/lib/catalog/sku";
import { getProductStockSummaries, summaryFor, type StockStatus } from "@/lib/catalog/stock-status";

const STOCK_STATUSES: StockStatus[] = ["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK"];

const querySchema = z.object({
  q: z.string().trim().optional(),
  categoryId: z.string().cuid().optional(),
  stockStatus: z.enum(["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK"]).optional(),
  lowStockOnly: z.coerce.boolean().optional(),
  isActive: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  // PRD §4.2: 2–3 characters, suggested from the name when left blank.
  code: z.string().trim().toUpperCase().regex(PRODUCT_CODE_PATTERN, PRODUCT_CODE_MESSAGE).optional(),
  categoryId: z.string().cuid().nullish(),
  brand: z.string().trim().max(120).nullish(),
  description: z.string().trim().max(4000).nullish(),
  fabric: z.string().trim().max(120).nullish(),
  basePrice: z.coerce.number().nonnegative(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  isActive: z.boolean().default(true),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission("product.view");
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  }
  const { q, categoryId, stockStatus, lowStockOnly, isActive, page, pageSize } = parsed.data;

  // Stock status/low-stock filters need the per-product aggregate computed
  // in JS (see lib/catalog/stock-status.ts) before we know which product ids
  // qualify, since it's a cross-column comparison Prisma can't express.
  let stockFilterIds: string[] | null = null;
  const summaries = stockStatus || lowStockOnly ? await getProductStockSummaries() : null;
  if (summaries) {
    const wanted = new Set<string>();
    for (const [productId, summary] of summaries) {
      const matchesStatus = !stockStatus || summary.status === stockStatus;
      const matchesLow = !lowStockOnly || summary.hasLowVariant || summary.status === "OUT_OF_STOCK";
      if (matchesStatus && matchesLow) wanted.add(productId);
    }
    stockFilterIds = Array.from(wanted);
    // Products with zero active variants never appear in the aggregate, but
    // they still count as OUT_OF_STOCK / low-stock-worthy — the DB where
    // clause below adds them back in via `variants: { none: {...} }`.
  }

  const noActiveVariantsMatch: Prisma.ProductWhereInput | undefined =
    !stockStatus || stockStatus === "OUT_OF_STOCK" ? { variants: { none: { isActive: true } } } : undefined;

  const andConditions: Prisma.ProductWhereInput[] = [{ deletedAt: null }];
  if (categoryId) andConditions.push({ categoryId });
  if (isActive !== undefined) andConditions.push({ isActive });
  if (q) {
    andConditions.push({
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { code: { contains: q, mode: "insensitive" } },
        { brand: { contains: q, mode: "insensitive" } },
        { variants: { some: { sku: { contains: q, mode: "insensitive" } } } },
      ],
    });
  }
  if (stockFilterIds) {
    andConditions.push({
      OR: [{ id: { in: stockFilterIds } }, ...(noActiveVariantsMatch ? [noActiveVariantsMatch] : [])],
    });
  }

  const where: Prisma.ProductWhereInput = { AND: andConditions };

  const [total, products] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        category: { select: { id: true, name: true } },
        images: { orderBy: { sortOrder: "asc" }, take: 1 },
        _count: { select: { variants: true } },
      },
    }),
  ]);

  const productIds = products.map((p) => p.id);
  const finalSummaries = summaries ?? (await getProductStockSummaries(productIds));

  const items = products.map((product) => ({
    ...product,
    basePrice: product.basePrice.toString(),
    stock: summaryFor(finalSummaries, product.id),
  }));

  const body = {
    items,
    total,
    page,
    pageSize,
    stockStatuses: STOCK_STATUSES,
  };

  return NextResponse.json(await stripCostFieldsForUser(body, guard.user));
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("product.create");
  if (!guard.ok) return guard.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { name, categoryId, brand, description, fabric, basePrice, tags, isActive } = parsed.data;
  let { code } = parsed.data;

  if (code) {
    const clash = await prisma.product.findUnique({ where: { code } });
    if (clash) return NextResponse.json({ error: "Product code already in use" }, { status: 409 });
  } else {
    code = await generateProductCode(prisma, name);
  }

  if (categoryId) {
    const category = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!category) return NextResponse.json({ error: "Category not found" }, { status: 400 });
  }

  const product = await prisma.product.create({
    data: {
      name,
      code,
      categoryId: categoryId ?? null,
      brand: brand ?? null,
      description: description ?? null,
      fabric: fabric ?? null,
      basePrice,
      tags,
      isActive,
      createdById: guard.user.id,
    },
    include: { category: { select: { id: true, name: true } } },
  });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "catalog.product.create",
    entityType: "product",
    entityId: product.id,
    after: { ...product, basePrice: product.basePrice.toString() },
    request,
  });

  return NextResponse.json(
    { product: { ...product, basePrice: product.basePrice.toString() } },
    { status: 201 },
  );
}
