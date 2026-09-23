import { variantStockStatus, type VariantStockStatus } from "./constants";

// PRD §4.2: "Low-stock alerts fire per variant, plus a product-level
// roll-up ('Kurti #12: only XL left')." Pure — the stock-report module
// feeds it every active variant of a product and gets back the alert (or
// null when nothing is low).

export type RollUpVariantInput = {
  variantId: string;
  sku: string;
  sizeName: string;
  colorName: string;
  colorHex: string;
  available: number;
  threshold: number;
};

export type LowStockVariant = RollUpVariantInput & { status: Exclude<VariantStockStatus, "OK"> };

export type ProductRollUp = {
  lowVariants: LowStockVariant[];
  outCount: number;
  lowCount: number;
  message: string;
};

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** Shortest label that still tells this product's variants apart: "XL", "Maroon", or "XL / Maroon". */
export function variantLabeler(variants: Pick<RollUpVariantInput, "sizeName" | "colorName">[]): (v: Pick<RollUpVariantInput, "sizeName" | "colorName">) => string {
  const oneColour = new Set(variants.map((v) => v.colorName)).size === 1;
  const oneSize = new Set(variants.map((v) => v.sizeName)).size === 1;
  if (oneColour && !oneSize) return (v) => v.sizeName;
  if (oneSize && !oneColour) return (v) => v.colorName;
  return (v) => `${v.sizeName} / ${v.colorName}`;
}

/** Variants are expected in display order (size, then colour). */
export function rollUpProductStock(variants: RollUpVariantInput[]): ProductRollUp | null {
  const lowVariants: LowStockVariant[] = [];
  for (const v of variants) {
    const status = variantStockStatus(v.available, v.threshold);
    if (status !== "OK") lowVariants.push({ ...v, status });
  }
  if (lowVariants.length === 0) return null;

  const outCount = lowVariants.filter((v) => v.status === "OUT").length;
  const lowCount = lowVariants.length - outCount;
  const inStock = variants.filter((v) => v.available > 0);
  const label = variantLabeler(variants);

  let message: string;
  if (variants.length === 1) {
    message = inStock.length === 0 ? "Out of stock" : `Only ${inStock[0].available} left`;
  } else if (inStock.length === 0) {
    message = "Out of stock in every variant";
  } else if (inStock.length <= 2 && inStock.length < variants.length) {
    message = `Only ${joinLabels(inStock.map(label))} left`;
  } else {
    const parts = [outCount > 0 ? `${outCount} out of stock` : null, lowCount > 0 ? `${lowCount} low` : null].filter(Boolean);
    message = `${parts.join(", ")} (of ${variants.length} variants)`;
  }

  return { lowVariants, outCount, lowCount, message };
}
