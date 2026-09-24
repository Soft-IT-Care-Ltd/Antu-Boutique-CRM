// What a price tag's barcode carries, and how the POS reads it back (P3.1).
// Pure and client-safe: the SKU edit route, the tag printer and the POS
// scan box all share these rules, so a tag always encodes a SKU the POS
// can find.

/**
 * SKUs are uppercase letters, digits and hyphens — exactly what the
 * generator produces (PRD-<code>-<SIZE>-<COLOR>). Nothing a scanner's
 * keyboard emulation could type differently, nothing Code 128 can't carry.
 */
export const SKU_PATTERN = /^[A-Z0-9-]{1,60}$/;

export const SKU_PATTERN_MESSAGE = "A SKU may only use capital letters A–Z, digits and hyphens (no spaces)";

export function isBarcodeSafeSku(sku: string): boolean {
  return SKU_PATTERN.test(sku);
}

const BANGLA = /[ঀ-৿]/;

/** True when the text came through a Bangla keyboard layout (Avro, Bijoy) — a scan can't match then. */
export function looksLikeBanglaKeyboard(raw: string): boolean {
  return BANGLA.test(raw);
}

/**
 * Turns what the scanner typed into the SKU it encodes. Scanners in keyboard
 * mode can add a prefix/suffix (Tab, CR/LF) and, with Caps Lock on, invert
 * letter case — SKUs are uppercase-only, so upper-casing undoes that.
 * Returns null when what's left can't be a SKU.
 */
export function normalizeScannedCode(raw: string): string | null {
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, "").trim().toUpperCase();
  return isBarcodeSafeSku(cleaned) ? cleaned : null;
}
