// What a price tag's barcode carries, and how the POS reads it back (P3.1).
// Pure and client-safe: the SKU edit route, the tag printer and the POS
// scan box all share these rules, so a tag always encodes a SKU the POS
// can find.

/**
 * SKUs are capital letters and digits, at most 9 (lib/catalog/codes.ts:
 * product + size + colour code). Nothing a scanner's keyboard emulation
 * could type differently, nothing Code 128 can't carry, and short enough for
 * reliable 0.25 mm bars on a 38 mm tag. Held by a DB CHECK too.
 */
export const SKU_PATTERN = /^[A-Z0-9]{1,9}$/;

export const SKU_PATTERN_MESSAGE = "A SKU is up to 9 capital letters and digits — no spaces or symbols";

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
