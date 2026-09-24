// PRD §4.2 — short SKUs. Pure and client-safe (also used by prisma/seed.ts).
//
//   SKU = product code (2–3) + size code (1–3) + colour code (2–3)
//   e.g. Embroidered Kurti #12, size M, Mustard Yellow → K12 + M + MYL = K12MMYL
//
// No separators: at most 9 characters, which is the longest Code 128 that
// prints with 2-dot (0.25 mm) bars and a proper quiet zone on a 38 mm label
// at 203 dpi. 1-dot bars fit more characters but a thermal head's ink spread
// closes the 1-dot spaces and the tag stops scanning (measured, P3.1).

export const PRODUCT_CODE_PATTERN = /^[A-Z0-9]{2,3}$/;
export const SIZE_CODE_PATTERN = /^[A-Z0-9]{1,3}$/;
export const COLOR_CODE_PATTERN = /^[A-Z0-9]{2,3}$/;

export const PRODUCT_CODE_MESSAGE = "Product code: 2–3 capital letters or digits (e.g. K12)";
export const SIZE_CODE_MESSAGE = "Size code: 1–3 capital letters or digits (e.g. M, XL, F)";
export const COLOR_CODE_MESSAGE = "Colour code: 2–3 capital letters or digits (e.g. MRN)";

/** The longest SKU a 38 mm tag at 203 dpi scans reliably — see the header. */
export const SKU_MAX_LENGTH = 9;

export function buildVariantSku(productCode: string, sizeCode: string, colorCode: string): string {
  return `${productCode}${sizeCode}${colorCode}`;
}

const VOWELS = new Set(["A", "E", "I", "O", "U"]);

const words = (name: string) => name.toUpperCase().match(/[A-Z]+/g) ?? [];

/** First letter + consonants after it (BLACK → B,L,C,K). */
function skeleton(word: string): string[] {
  return [word[0], ...[...word.slice(1)].filter((ch) => !VOWELS.has(ch))];
}

/** Once the obvious code is taken: number it (MRN → MR2, K12 → K13), then vary its last letter. */
function* variants(base: string, pool: string[], min: number, max: number): Generator<string> {
  yield base;
  // A short code grows (M → M2, RD → RD2); a full-length one swaps its last character (MRN → MR2).
  const stem = base.length < max ? base : base.slice(0, max - 1);
  const lastDigit = /\d$/.test(base) ? Number(base[base.length - 1]) : 1;
  for (let d = lastDigit + 1; d <= 9; d += 1) yield `${stem}${d}`;
  for (const ch of pool) if (!stem.includes(ch) && stem.length + 1 >= min) yield stem + ch;
  const first = base[0] ?? "X";
  for (let n = 10; n <= 99 && max >= 3; n += 1) yield `${first}${n}`;
}

function firstFree(candidates: Iterable<string>, pattern: RegExp, taken: ReadonlySet<string>): string | null {
  for (const c of candidates) if (pattern.test(c) && !taken.has(c)) return c;
  return null;
}

/**
 * Maroon → MRN, Mustard Yellow → MYL, Navy Blue → NBL, Black → BLK, Red → RD.
 * One word: its first letter, next consonant and last consonant. Two words:
 * both initials + the second word's next consonant. Three+: the first three initials.
 */
export function suggestColorCode(name: string, taken: ReadonlySet<string> = new Set()): string | null {
  const w = words(name);
  if (w.length === 0) return firstFree(variants("CL", [], 2, 3), COLOR_CODE_PATTERN, taken);
  let base: string;
  if (w.length >= 3) base = w.slice(0, 3).map((x) => x[0]).join("");
  else if (w.length === 2) {
    const tail = skeleton(w[1]);
    base = `${w[0][0]}${w[1][0]}${tail[1] ?? ""}`;
  } else {
    const word = w[0]!;
    const sk = skeleton(word);
    base = sk.length >= 3 ? `${sk[0]}${sk[1]}${sk[sk.length - 1]}` : sk.length === 2 ? sk.join("") : word.slice(0, 2);
  }
  const pool = [...new Set(w.join("").split(""))];
  return firstFree(variants(base.slice(0, 3), pool, 2, 3), COLOR_CODE_PATTERN, taken);
}

/** Free → F, XL → XL, 32 → 32; anything longer is cut to 3. */
export function suggestSizeCode(name: string, taken: ReadonlySet<string> = new Set()): string | null {
  const clean = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const base = /^FREE/.test(clean) ? "F" : clean.slice(0, 3) || "Z";
  return firstFree(variants(base, clean.split(""), 1, 3), SIZE_CODE_PATTERN, taken);
}

/**
 * Kurti 12 → K12, Embroidered Kurti → EK, Jamdani Saree — Classic → JSC,
 * Kurti → KRT: a number in the name follows its first initial; otherwise
 * initials, or a single word's consonants.
 */
export function suggestProductCode(name: string, taken: ReadonlySet<string> = new Set()): string | null {
  const w = words(name);
  const digits = name.match(/\d+/)?.[0] ?? "";
  const initials = w.map((x) => x[0]).join("");
  let base: string;
  if (digits && initials) base = `${initials[0]}${digits}`.slice(0, 3);
  else if (digits) base = digits.slice(0, 3).padEnd(2, "0");
  else if (initials.length >= 2) base = initials.slice(0, 3);
  else if (w[0]) {
    const sk = skeleton(w[0]);
    base = (sk.length >= 3 ? `${sk[0]}${sk[1]}${sk[sk.length - 1]}` : w[0].slice(0, 3)).padEnd(2, "X");
  } else base = "PR";
  const pool = [...new Set(w.join("").split(""))];
  return firstFree(variants(base, pool, 2, 3), PRODUCT_CODE_PATTERN, taken);
}
