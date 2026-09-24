-- P3.3 — outfit sets built from products (PRD §4.2), their lines on orders,
-- and packaging materials (component-only products). CHECKs using the new
-- enum values are in 20260928090100.
-- CreateEnum
CREATE TYPE "ProductKind" AS ENUM ('SELLABLE', 'COMPONENT_ONLY');

-- CreateEnum
CREATE TYPE "PackagingScope" AS ENUM ('ONLINE_PARCEL', 'POS_SALE');

-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE 'PACKAGING_OUT';

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "packagingOrderId" TEXT;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "setLineId" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "kind" "ProductKind" NOT NULL DEFAULT 'SELLABLE';

-- CreateTable
CREATE TABLE "outfit_sets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outfit_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outfit_set_components" (
    "id" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "outfit_set_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packaging_components" (
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "outfitSetId" TEXT,
    "scope" "PackagingScope",
    "materialVariantId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "packaging_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_set_lines" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "outfitSetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "lineDiscount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_set_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outfit_sets_deletedAt_idx" ON "outfit_sets"("deletedAt");

-- CreateIndex
CREATE INDEX "outfit_set_components_productId_idx" ON "outfit_set_components"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "outfit_set_components_setId_productId_key" ON "outfit_set_components"("setId", "productId");

-- CreateIndex
CREATE INDEX "packaging_components_materialVariantId_idx" ON "packaging_components"("materialVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "packaging_components_productId_materialVariantId_key" ON "packaging_components"("productId", "materialVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "packaging_components_outfitSetId_materialVariantId_key" ON "packaging_components"("outfitSetId", "materialVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "packaging_components_scope_materialVariantId_key" ON "packaging_components"("scope", "materialVariantId");

-- CreateIndex
CREATE INDEX "order_set_lines_orderId_idx" ON "order_set_lines"("orderId");

-- CreateIndex
CREATE INDEX "order_set_lines_outfitSetId_idx" ON "order_set_lines"("outfitSetId");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_packagingOrderId_key" ON "expenses"("packagingOrderId");

-- CreateIndex
CREATE INDEX "order_items_setLineId_idx" ON "order_items"("setLineId");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_setLineId_fkey" FOREIGN KEY ("setLineId") REFERENCES "order_set_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_packagingOrderId_fkey" FOREIGN KEY ("packagingOrderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outfit_sets" ADD CONSTRAINT "outfit_sets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outfit_set_components" ADD CONSTRAINT "outfit_set_components_setId_fkey" FOREIGN KEY ("setId") REFERENCES "outfit_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outfit_set_components" ADD CONSTRAINT "outfit_set_components_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packaging_components" ADD CONSTRAINT "packaging_components_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packaging_components" ADD CONSTRAINT "packaging_components_outfitSetId_fkey" FOREIGN KEY ("outfitSetId") REFERENCES "outfit_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packaging_components" ADD CONSTRAINT "packaging_components_materialVariantId_fkey" FOREIGN KEY ("materialVariantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_set_lines" ADD CONSTRAINT "order_set_lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_set_lines" ADD CONSTRAINT "order_set_lines_outfitSetId_fkey" FOREIGN KEY ("outfitSetId") REFERENCES "outfit_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

