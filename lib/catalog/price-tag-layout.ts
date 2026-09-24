import { code128Bars } from "@/lib/barcode/code128";
import { isBarcodeSafeSku } from "@/lib/barcode/scan";
import { formatBDT } from "@/lib/money";

// P3.1 price tags — the layout of one tag, shared by the on-screen preview
// and the PDF (lib/catalog/price-tags.ts), so what staff see is what prints.
// Pure and client-safe; every length is in millimetres.
//
// The barcode is Code 128 of the variant's SKU, exactly (lib/barcode/*).
// Its bars are snapped to the printer's dot grid: a thermal label printer
// at 203 dpi prints in 0.125 mm dots, and a bar that falls between dots
// prints a dot too wide or too narrow — enough to make a dense barcode
// unreadable. Whole-dot bars keep every bar exactly the width the scanner
// expects.

export type LabelStock =
  | { kind: "ROLL"; id: string; label: string; width: number; height: number }
  | { kind: "SHEET"; id: string; label: string; width: number; height: number; cols: number; rows: number; marginTop: number; marginLeft: number; gapX: number; gapY: number };

export const LABEL_STOCKS: readonly LabelStock[] = [
  { kind: "ROLL", id: "roll-50x25", label: "Label printer · 50 × 25 mm", width: 50, height: 25 },
  { kind: "ROLL", id: "roll-40x30", label: "Label printer · 40 × 30 mm", width: 40, height: 30 },
  { kind: "ROLL", id: "roll-38x25", label: "Label printer · 38 × 25 mm", width: 38, height: 25 },
  { kind: "ROLL", id: "roll-60x40", label: "Label printer · 60 × 40 mm", width: 60, height: 40 },
  // Edge-to-edge A4 sticker sheets (the common "A4 24 / 40 / 21 labels" packs).
  { kind: "SHEET", id: "a4-24", label: "A4 sheet · 24 labels (3 × 8, 70 × 37 mm)", width: 70, height: 37.125, cols: 3, rows: 8, marginTop: 0, marginLeft: 0, gapX: 0, gapY: 0 },
  { kind: "SHEET", id: "a4-40", label: "A4 sheet · 40 labels (4 × 10, 52.5 × 29.7 mm)", width: 52.5, height: 29.7, cols: 4, rows: 10, marginTop: 0, marginLeft: 0, gapX: 0, gapY: 0 },
  { kind: "SHEET", id: "a4-21", label: "A4 sheet · 21 labels (3 × 7, 70 × 42.4 mm)", width: 70, height: 42.4, cols: 3, rows: 7, marginTop: 0.8, marginLeft: 0, gapX: 0, gapY: 0 },
];

export const DEFAULT_LABEL_STOCK_ID = "roll-50x25";

/** Label printers are 203 or 300 dpi; sheets go through an office laser/inkjet (600 dpi grid). */
export const ROLL_PRINTER_DPIS = [203, 300] as const;
export type RollPrinterDpi = (typeof ROLL_PRINTER_DPIS)[number];
const SHEET_DPI = 600;

export const A4 = { width: 210, height: 297 } as const;

export function findLabelStock(id: string): LabelStock | undefined {
  return LABEL_STOCKS.find((s) => s.id === id);
}

export type TagData = { sku: string; productName: string; sizeName: string; colorName: string; price: string };

/**
 * The narrowest bar that survives a thermal head's ink spread: at 203 dpi,
 * 2 dots. Measured (P3.1): with one dot of spread, 1-dot bars (0.125 mm)
 * close their 1-dot spaces and stop scanning; 2-dot bars keep reading.
 * (Dot sizes aren't exact: 2 dots at 203 dpi is 0.2502 mm, hence the slack.)
 */
const MIN_RELIABLE_MODULE_MM = 0.249;
/**
 * Quiet zone either side, in bar widths. The spec asks for 10; a tag's own
 * edges run into blank liner, and 5 read reliably under ink spread in the
 * same test, so 6 keeps a margin while letting a 9-character SKU fit 38 mm.
 */
const TAG_QUIET_ZONE_MODULES = 6;
/** Left for the label drifting sideways in the printer, each side. */
const DRIFT_MM = 0.4;

export type BarcodeFit = {
  modules: number;
  /** Width of one module (the narrowest bar), in mm — a whole number of printer dots. */
  moduleMm: number;
  dots: number;
  widthMm: number;
  /** "ok" scans reliably; "too-long" can't get 0.25 mm bars on this label — refused. */
  quality: "ok" | "too-long";
};

/**
 * How wide each bar can be for this SKU on this label: the widest whole
 * number of printer dots that fits the bars plus their quiet zones.
 */
export function fitBarcode(sku: string, stock: LabelStock, dpi: number): BarcodeFit {
  const { modules } = code128Bars(sku);
  const dotMm = 25.4 / dpi;
  const usableMm = stock.width - 2 * DRIFT_MM;
  const withQuiet = modules + 2 * TAG_QUIET_ZONE_MODULES;
  const dots = Math.max(1, Math.floor(usableMm / (withQuiet * dotMm)));
  const moduleMm = dots * dotMm;
  const quality = moduleMm >= MIN_RELIABLE_MODULE_MM && withQuiet * moduleMm <= usableMm ? "ok" : "too-long";
  return { modules, moduleMm, dots, widthMm: modules * moduleMm, quality };
}

export function stockDpi(stock: LabelStock, rollDpi: RollPrinterDpi): number {
  return stock.kind === "ROLL" ? rollDpi : SHEET_DPI;
}

function esc(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const snap = (mm: number, dotMm: number) => Math.round(mm / dotMm) * dotMm;

/**
 * One tag's inner HTML, positioned absolutely inside a box of the label's
 * size whose top-left sits at (originX, originY) on the page — so the
 * barcode can be snapped to the page's dot grid, not just the tag's.
 */
export function renderTagHtml(tag: TagData, stock: LabelStock, dpi: number, origin: { x: number; y: number } = { x: 0, y: 0 }): string {
  const dotMm = 25.4 / dpi;
  const h = stock.height;
  // Type scales with the label: a 25 mm tag gets ~7 pt text, a 40 mm one more.
  const k = Math.min(1.35, Math.max(0.85, h / 25));
  const pad = 1.4 * k;
  const nameSize = 2.7 * k;
  const metaSize = 2.5 * k;
  const priceSize = 3.4 * k;
  const skuSize = 1.9 * k;
  const barHeight = Math.max(6, h - pad * 2 - nameSize * 1.25 - priceSize * 1.25 - skuSize * 1.3 - 1.2);

  const barTop = pad + nameSize * 1.25 + priceSize * 1.25 + 0.4;

  let barcode = "";
  if (isBarcodeSafeSku(tag.sku)) {
    const fit = fitBarcode(tag.sku, stock, dpi);
    const { bars } = code128Bars(tag.sku);
    // Snap the barcode's absolute page position to the dot grid, so every
    // bar edge lands exactly on a printer dot boundary.
    const left = snap(origin.x + (stock.width - fit.widthMm) / 2, dotMm) - origin.x;
    const rects = bars.map((b) => `<rect x="${b.x}" y="0" width="${b.width}" height="1"/>`).join("");
    const style = `top:${barTop.toFixed(2)}mm;left:${left.toFixed(4)}mm;width:${fit.widthMm.toFixed(4)}mm;height:${barHeight.toFixed(2)}mm`;
    barcode = `<svg class="bc" style="${style}" viewBox="0 0 ${fit.modules} 1" preserveAspectRatio="none" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
  }

  return `
    <div class="name" style="top:${pad}mm;left:${pad}mm;right:${pad}mm;font-size:${nameSize}mm;line-height:1.2">${esc(tag.productName)}</div>
    <div class="meta" style="top:${(pad + nameSize * 1.25).toFixed(2)}mm;left:${pad}mm;right:${pad}mm;height:${(priceSize * 1.25).toFixed(2)}mm">
      <span style="font-size:${metaSize}mm">${esc(tag.sizeName)} · ${esc(tag.colorName)}</span>
      <span class="price" style="font-size:${priceSize}mm">${esc(formatBDT(tag.price))}</span>
    </div>
    ${barcode}
    <div class="sku" style="top:${(barTop + barHeight + 0.3).toFixed(2)}mm;font-size:${skuSize}mm">${esc(tag.sku)}</div>`;
}

/** The CSS every tag needs (fonts are the caller's — the PDF embeds the Bangla font). */
export const TAG_CSS = `
  .tag { position: absolute; overflow: hidden; background: #fff; color: #000; font-family: 'Invoice Sans', 'Noto Sans Bengali', system-ui, sans-serif; }
  .tag > * { position: absolute; margin: 0; }
  .tag .name { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tag .meta { display: flex; justify-content: space-between; align-items: baseline; gap: 1mm; white-space: nowrap; }
  .tag .meta span:first-child { overflow: hidden; text-overflow: ellipsis; }
  .tag .price { font-weight: 700; }
  .tag .bc { display: block; }
  .tag .bc rect { fill: #000; }
  .tag .sku { left: 0; right: 0; text-align: center; letter-spacing: 0.02em; font-family: 'Invoice Sans', ui-monospace, monospace; }
`;

export type PlacedTag = { tag: TagData; page: number; x: number; y: number };

/**
 * Where every tag goes: one per page on a roll; left-to-right, top-to-bottom
 * on sheets, starting at label `startAt` (1-based) so a half-used sheet can
 * be fed back in.
 */
export function placeTags(tags: TagData[], stock: LabelStock, startAt = 1): { placed: PlacedTag[]; pages: number } {
  if (stock.kind === "ROLL") return { placed: tags.map((tag, page) => ({ tag, page, x: 0, y: 0 })), pages: tags.length };
  const perSheet = stock.cols * stock.rows;
  const skip = Math.min(Math.max(0, startAt - 1), perSheet - 1);
  const placed = tags.map((tag, i) => {
    const slot = i + skip;
    const page = Math.floor(slot / perSheet);
    const inPage = slot % perSheet;
    const col = inPage % stock.cols;
    const row = Math.floor(inPage / stock.cols);
    return { tag, page, x: stock.marginLeft + col * (stock.width + stock.gapX), y: stock.marginTop + row * (stock.height + stock.gapY) };
  });
  return { placed, pages: tags.length === 0 ? 0 : Math.floor((tags.length - 1 + skip) / perSheet) + 1 };
}
