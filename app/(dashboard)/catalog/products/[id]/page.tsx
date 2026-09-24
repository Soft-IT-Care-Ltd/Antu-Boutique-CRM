import { notFound } from "next/navigation";

import { ProductDetail } from "@/components/catalog/product-detail";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { loadProductDetail, serializeProductDetail } from "@/lib/catalog/product-detail";
import { getProductStockSummaries, summaryFor } from "@/lib/catalog/stock-status";
import { prisma } from "@/lib/prisma";

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await guardPage("/catalog");
  const { id } = await params;

  const productRow = await loadProductDetail(id);
  if (!productRow) notFound();

  const [summaries, categories, sizes, colors, canEdit, canGenerateVariants, canDelete, hasCostView, canPrintTags] = await Promise.all([
    getProductStockSummaries([id]),
    prisma.category.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.size.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.color.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    can(user, "product.edit"),
    can(user, "product.create"),
    can(user, "product.delete"),
    can(user, "product.cost.view"),
    can(user, "product.tags.print"),
  ]);

  const serialized = serializeProductDetail(productRow, summaryFor(summaries, id).available);
  const product = await stripCostFieldsForUser(serialized, user);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-4xl md:p-6">
      <ProductDetail
        product={product}
        categories={categories}
        sizes={sizes}
        colors={colors}
        canEdit={canEdit}
        canGenerateVariants={canGenerateVariants}
        canDelete={canDelete}
        hasCostView={hasCostView}
        canPrintTags={canPrintTags}
      />
    </div>
  );
}
