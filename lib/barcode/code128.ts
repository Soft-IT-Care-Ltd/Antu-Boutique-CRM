// Code 128 barcode encoder for price tags (P3.1). Pure and client-safe.
//
// Why Code 128: it encodes every printable ASCII character — a SKU's
// letters, digits and hyphens — at the highest density of the common 1D
// symbologies, and every USB/Bluetooth POS scanner reads it out of the box.
// A scanner in keyboard mode types back exactly the text encoded here and
// presses Enter, which is what the POS scan box listens for.
//
// Code set B carries everything; runs of digits switch to code set C (two
// digits per symbol) so numeric stretches don't widen the tag.

/**
 * Bar/space widths (in modules) for symbol values 0–106. Each symbol is
 * bar-space-bar-space-bar-space, 11 modules wide; 106 (STOP) has a final
 * 2-module bar, 13 modules in all.
 */
export const CODE128_PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

export const CODE128 = {
  START_B: 104,
  START_C: 105,
  CODE_B: 100, // in set C: switch to B
  CODE_C: 99, // in set B: switch to C
  STOP: 106,
} as const;

/** Recommended quiet zone either side of the bars, in modules. */
export const CODE128_QUIET_ZONE_MODULES = 10;

export class BarcodeError extends Error {}

const isDigit = (c: string) => c >= "0" && c <= "9";

function digitRunAt(text: string, from: number): number {
  let n = 0;
  while (from + n < text.length && isDigit(text[from + n])) n += 1;
  return n;
}

/** Symbol values from the start code to the check symbol (STOP not included). */
export function code128Values(text: string): number[] {
  if (text.length === 0) throw new BarcodeError("Nothing to encode");
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) throw new BarcodeError(`"${ch}" can't be printed as a barcode — only plain letters, digits and symbols can.`);
  }

  const values: number[] = [];
  let set: "B" | "C";
  let i = 0;

  const leadRun = digitRunAt(text, 0);
  if (leadRun >= 4 && leadRun % 2 === 0) {
    set = "C";
    values.push(CODE128.START_C);
  } else {
    set = "B";
    values.push(CODE128.START_B);
  }

  while (i < text.length) {
    if (set === "C") {
      if (digitRunAt(text, i) >= 2) {
        values.push(Number(text.slice(i, i + 2)));
        i += 2;
        continue;
      }
      values.push(CODE128.CODE_B);
      set = "B";
      continue;
    }

    // Set B. Switch to C for a digit run worth it: 6+ digits mid-text, or
    // 4+ that run to the end. An odd run keeps its first digit in B.
    const run = digitRunAt(text, i);
    const worthC = run >= 6 || (run >= 4 && i + run === text.length);
    if (worthC && run % 2 === 0) {
      values.push(CODE128.CODE_C);
      set = "C";
      continue;
    }
    values.push(text.charCodeAt(i) - 32);
    i += 1;
  }

  let sum = values[0];
  for (let k = 1; k < values.length; k += 1) sum += k * values[k];
  values.push(sum % 103);
  return values;
}

/** Alternating bar/space widths in modules, starting and ending with a bar (STOP included). */
export function code128Widths(text: string): number[] {
  const widths: number[] = [];
  for (const value of [...code128Values(text), CODE128.STOP]) {
    for (const w of CODE128_PATTERNS[value]) widths.push(Number(w));
  }
  return widths;
}

export type BarcodeBar = { x: number; width: number };

/** The dark bars as module offsets, plus the total width in modules (quiet zones excluded). */
export function code128Bars(text: string): { bars: BarcodeBar[]; modules: number } {
  const widths = code128Widths(text);
  const bars: BarcodeBar[] = [];
  let x = 0;
  widths.forEach((w, index) => {
    if (index % 2 === 0) bars.push({ x, width: w });
    x += w;
  });
  return { bars, modules: x };
}
