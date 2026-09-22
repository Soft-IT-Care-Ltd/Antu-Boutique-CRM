import "server-only";

import { prisma } from "@/lib/prisma";

export async function loadProductDetail(id: string) {
  return prisma.product.findFirst({
    where: { id, deletedAt: null },
    include: {
      category: { select: { id: true, name: true } },
      images: { orderBy: { sortOrder: "asc" } },
      variants: {
        include: { size: true, color: true },
        orderBy: [{ size: { sortOrder: "asc" } }, { color: { sortOrder: "asc" } }],
      },
    },
  });
}

export type LoadedProduct = NonNullable<Awaited<ReturnType<typeof loadProductDetail>>>;

export function serializeProductDetail(product: LoadedProduct, available: number) {
  return {
    ...product,
    basePrice: product.basePrice.toString(),
    variants: product.variants.map((variant) => ({
      ...variant,
      weightedAvgCost: variant.weightedAvgCost.toString(),
      priceOverride: variant.priceOverride?.toString() ?? null,
      available: variant.stockQty - variant.reservedQty,
    })),
    stockAvailable: available,
  };
}
