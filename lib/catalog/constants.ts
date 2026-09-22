// Falls back for a variant whose low_stock_threshold is null. PRD §4.2 calls
// this "default from settings" — Settings isn't built until Phase 5, so this
// constant stands in until that screen can override it per variant.
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

export const MAX_PRODUCT_IMAGES = 10;

export const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
