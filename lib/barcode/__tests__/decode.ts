import { CODE128, CODE128_PATTERNS } from "@/lib/barcode/code128";

// A decoder written against the Code 128 spec, independent of the encoder's
// code-set choices: it reads bar/space widths back into symbols, checks the
// checksum and replays code-set switches. If a tag's widths decode to the
// SKU here, a scanner reading the same widths types the same SKU.
export function decodeCode128Widths(widths: number[]): string {
  const symbolFor = new Map(CODE128_PATTERNS.map((p, value) => [p, value]));
  const values: number[] = [];
  let i = 0;
  while (i < widths.length) {
    const take = widths.length - i === 7 ? 7 : 6;
    const pattern = widths.slice(i, i + take).join("");
    const value = symbolFor.get(pattern);
    if (value === undefined) throw new Error(`Unknown pattern ${pattern} at ${i}`);
    values.push(value);
    i += take;
  }
  if (values[values.length - 1] !== CODE128.STOP) throw new Error("No STOP symbol");
  const data = values.slice(0, -2);
  const check = values[values.length - 2];
  const sum = data.reduce((acc, v, k) => acc + (k === 0 ? v : k * v), 0);
  if (sum % 103 !== check) throw new Error(`Bad check symbol: ${check}, expected ${sum % 103}`);
  if (data[0] !== CODE128.START_B && data[0] !== CODE128.START_C) throw new Error("No start symbol");

  let set: "B" | "C" = data[0] === CODE128.START_C ? "C" : "B";
  let out = "";
  for (const v of data.slice(1)) {
    if (set === "B" && v === CODE128.CODE_C) set = "C";
    else if (set === "C" && v === CODE128.CODE_B) set = "B";
    else if (set === "B") out += String.fromCharCode(v + 32);
    else out += String(v).padStart(2, "0");
  }
  return out;
}


/**
 * A price tag's or shelf label's barcode as drawn (lib/catalog/price-tag-layout.ts
 * barcodeSvgHtml): bar/space widths (in modules) drawn by its <svg>, and its box's left edge on the page in CSS px. */
export function drawnBarcode(html: string, dots: number, dpi: number, originXmm = 0) {
  const svg = html.match(/<svg class="bc" style="[^"]*left:(-?[\d.]+)px;width:(\d+)px;[^"]*" viewBox="0 0 (\d+) 1"/);
  if (!svg) throw new Error("no barcode svg");
  const modulePx = (dots * 96) / dpi;
  const rects = [...html.matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)"/g)].map((m) => ({ x: Number(m[1]) / modulePx, w: Number(m[2]) / modulePx }));
  const widths: number[] = [];
  rects.forEach((r, i) => {
    widths.push(Math.round(r.w * 1e4) / 1e4);
    if (i < rects.length - 1) widths.push(Math.round((rects[i + 1].x - r.x - r.w) * 1e4) / 1e4);
  });
  const boxLeftPx = Number(svg[1]) + (originXmm * 96) / 25.4;
  const firstBarDots = ((boxLeftPx + Number(rects[0].x) * modulePx) * dpi) / 96;
  return { widths, boxLeftPx, boxWidthPx: Number(svg[2]), viewBoxWidth: Number(svg[3]), firstBarDots };
}
