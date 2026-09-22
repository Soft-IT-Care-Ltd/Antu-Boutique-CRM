// BDT formatting in Bangladeshi lakh/crore digit grouping, e.g. ৳ 1,42,000.
// Money fields are stored as Prisma Decimal (see CLAUDE.md); this accepts
// anything Decimal-shaped (has a toString), a plain number, or a numeric string.

type MoneyInput = number | string | { toString(): string };

const TAKA_SIGN = "৳"; // ৳

// Explicit .toString() first rather than a bare Number(decimal) — relying
// on Decimal.js's implicit valueOf() coercion works today but is easy to
// get subtly wrong later, so every caller that needs to do arithmetic on a
// Prisma Decimal (order totals, price-floor checks, ...) goes through here.
export function toNumber(amount: MoneyInput): number {
  return typeof amount === "number" ? amount : Number(amount.toString());
}

/** ৳ 1,42,000 or ৳ 1,42,000.50 if the amount has a fractional part. */
export function formatBDT(amount: MoneyInput): string {
  const value = toNumber(amount);
  if (Number.isNaN(value)) return `${TAKA_SIGN} 0`;

  const hasFraction = !Number.isInteger(value);
  const formatted = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(value);

  return `${TAKA_SIGN} ${formatted}`;
}

/** Digit-grouped number only, no currency sign — for inputs/exports. */
export function formatLakh(amount: MoneyInput): string {
  const value = toNumber(amount);
  if (Number.isNaN(value)) return "0";

  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}
