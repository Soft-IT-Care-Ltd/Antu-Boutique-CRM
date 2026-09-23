// Client-side shapes mirroring the JSON the /api/catalog/* routes return.
// Cost-only fields (weightedAvgCost) are optional because
// stripCostFieldsForUser removes them entirely for roles without
// product.cost.view — never render assuming they exist.

export type Category = {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
  _count?: { products: number; children: number };
};

export type SizeMaster = {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  _count?: { variants: number };
};

export type ColorMaster = {
  id: string;
  name: string;
  hexCode: string;
  sortOrder: number;
  isActive: boolean;
  _count?: { variants: number };
};

export type StockStatus = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";

export type StockSummary = {
  available: number;
  hasLowVariant: boolean;
  status: StockStatus;
};

export type ProductImage = {
  id: string;
  productId: string;
  filePath: string;
  thumbPath: string;
  sortOrder: number;
};

export type ProductListItem = {
  id: string;
  code: string;
  name: string;
  brand: string | null;
  basePrice: string;
  isActive: boolean;
  category: { id: string; name: string } | null;
  images: ProductImage[];
  _count: { variants: number };
  stock: StockSummary;
};

export type ProductVariant = {
  id: string;
  productId: string;
  sizeId: string;
  colorId: string;
  size: SizeMaster;
  color: ColorMaster;
  sku: string;
  skuLocked: boolean;
  stockQty: number;
  reservedQty: number;
  available: number;
  weightedAvgCost?: string;
  priceOverride: string | null;
  lowStockThreshold: number | null;
  weightGrams: number | null;
  isActive: boolean;
};

export type ProductDetail = {
  id: string;
  code: string;
  name: string;
  categoryId: string | null;
  category: { id: string; name: string } | null;
  brand: string | null;
  description: string | null;
  fabric: string | null;
  basePrice: string;
  tags: string[];
  isActive: boolean;
  images: ProductImage[];
  variants: ProductVariant[];
  stockAvailable: number;
};

export function uploadUrl(relativePath: string): string {
  return `/uploads/${relativePath}`;
}
