// Reading the cells of an opening-data sheet. Forgiving about what a person
// or Excel types (৳ signs, thousands commas, Bangla digits, 25/09/2026),
// strict about what it means. Pure; no server-only.

const BANGLA_DIGITS = "০১২৩৪৫৬৭৮৯";

function asciiDigits(input: string): string {
  return input.replace(/[০-৯]/g, (d) => String(BANGLA_DIGITS.indexOf(d)));
}

/** "৳ 1,42,000.50" → 142000.5; blank → null; anything else → NaN. */
export function readNumber(input: string | undefined): number | null {
  const raw = asciiDigits(input ?? "").replace(/[৳,\s]/g, "").replace(/^tk\.?/i, "");
  if (raw === "") return null;
  return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
}

/** Money with at most 2 decimals, as a string for Prisma.Decimal; null when blank. Throws a message for anything else. */
export function readMoney(input: string | undefined, label: string, { min = 0 }: { min?: number } = {}): string | null {
  const n = readNumber(input);
  if (n === null) return null;
  if (Number.isNaN(n)) throw new Error(`${label} "${input}" isn't a number`);
  if (n < min) throw new Error(`${label} can't be below ${min}`);
  if (n > 100_000_000) throw new Error(`${label} is too large`);
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) throw new Error(`${label} has more than 2 decimals`);
  return n.toFixed(2);
}

export function readWholeNumber(input: string | undefined, label: string, { min = 0, max = 1_000_000 }: { min?: number; max?: number } = {}): number | null {
  const n = readNumber(input);
  if (n === null) return null;
  if (!Number.isInteger(n)) throw new Error(`${label} "${input}" must be a whole number`);
  if (n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}`);
  return n;
}

/**
 * YYYY-MM-DD, or day first as Bangladesh writes it (25/09/2026, 25-09-2026,
 * 25.09.2026). Never month-first: 03/04/2026 is 3 April.
 */
export function readDay(input: string | undefined, label: string): string | null {
  const raw = asciiDigits(input ?? "").trim();
  if (raw === "") return null;
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(raw))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else throw new Error(`${label} "${input}" — write dates as YYYY-MM-DD or DD/MM/YYYY`);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw new Error(`${label} "${input}" isn't a real date`);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "a; b | c" → ["a", "b", "c"]. Semicolons (or |) separate a list inside one cell — commas are the CSV's own. */
export function readList(input: string | undefined): string[] {
  return (input ?? "")
    .split(/[;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Case- and space-insensitive key for matching a typed name to a master ("navy  blue" = "Navy Blue"). */
export function nameKey(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}
