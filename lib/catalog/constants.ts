// PRD §4.2 "low_stock_threshold — per variant, default from settings": a
// variant with no threshold of its own uses Settings → Orders & stock
// (`low_stock_default`), and this when that has never been set. Every
// stock query reads the setting in SQL (lib/catalog/low-stock-threshold.ts).
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;
export const LOW_STOCK_DEFAULT_SETTING_KEY = "low_stock_default";

export const MAX_PRODUCT_IMAGES = 10;

export const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
