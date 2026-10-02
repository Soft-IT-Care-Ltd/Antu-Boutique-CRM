import "server-only";

import { A4, barcodeSvgHtml, fitBarcode, placeTags, type LabelStock } from "@/lib/catalog/price-tag-layout";
import type { Db } from "@/lib/db/tx";
import { getFontFaceCss, renderHtmlToPdf } from "@/lib/pdf/render";
import { compareShelfCodes } from "@/lib/shelves/constants";

// C4b — CORRECTIONS.md item 20A: a label for each shelf/box, printed on the
// same label printer (and label sizes) as the price tags. The barcode is
// Code 128 of the shelf code itself (A-2-3) — the hyphen keeps it from ever
// reading as a dress's SKU. The code is also printed big, to read from the aisle.

export class ShelfLabelError extends Error {}

export const MAX_SHELF_LABELS = 500;

export type ShelfLabel = { code: string; locationName: string };

export async function shelfLabelsFor(db: Db, shelfIds: string[], copies: number): Promise<ShelfLabel[]> {
  const shelves = await db.shelf.findMany({ where: { id: { in: shelfIds } }, select: { code: true, location: { select: { name: true } } } });
  if (shelves.length === 0) throw new ShelfLabelError("Pick at least one shelf.");
  const total = shelves.length * copies;
  if (total > MAX_SHELF_LABELS) throw new ShelfLabelError(`That's ${total} labels — print at most ${MAX_SHELF_LABELS} at a time.`);
  return shelves
    .sort((a, b) => compareShelfCodes(a.code, b.code))
    .flatMap((s) => Array.from({ length: copies }, () => ({ code: s.code, locationName: s.location.name })));
}

function esc(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function shelfLabelHtml(label: ShelfLabel, stock: LabelStock, dpi: number, origin: { x: number; y: number } = { x: 0, y: 0 }): string {
  const h = stock.height;
  const pad = 1.2;
  const placeSize = Math.min(2.4, h * 0.09);
  const codeSize = Math.min(9, h * 0.3);
  const fit = fitBarcode(label.code, stock, dpi);
  if (fit.quality === "too-long") throw new ShelfLabelError(`${label.code} is too long for a ${stock.width} mm label — pick a wider label or an A4 sheet.`);
  const barTop = pad + placeSize * 1.3 + codeSize * 1.05;
  const barHeight = Math.max(5, h - barTop - pad);
  return `
    <div class="place" style="top:${pad}mm;font-size:${placeSize}mm">${esc(label.locationName)}</div>
    <div class="code" style="top:${(pad + placeSize * 1.3).toFixed(2)}mm;font-size:${codeSize}mm;line-height:1">${esc(label.code)}</div>
    ${barcodeSvgHtml(label.code, fit, dpi, { origin, centreMm: stock.width / 2, topMm: barTop, heightMm: barHeight, className: "bc" })}`;
}

export async function renderShelfLabelsPdf(labels: ShelfLabel[], stock: LabelStock, dpi: number, startAt: number): Promise<Uint8Array> {
  const { placed, pages } = placeTags(labels, stock, startAt);
  const pageW = stock.kind === "ROLL" ? stock.width : A4.width;
  const pageH = stock.kind === "ROLL" ? stock.height : A4.height;
  const body = Array.from({ length: pages }, (_, page) => {
    const html = placed
      .filter((p) => p.page === page)
      .map((p) => `<div class="label" style="left:${p.x}mm;top:${p.y}mm;width:${stock.width}mm;height:${stock.height}mm">${shelfLabelHtml(p.tag, stock, dpi, { x: p.x, y: p.y })}</div>`)
      .join("");
    return `<section class="page">${html}</section>`;
  }).join("");
  const html = `<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8" />
<style>
  ${await getFontFaceCss()}
  @page { size: ${pageW}mm ${pageH}mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  .page { position: relative; width: ${pageW}mm; height: ${pageH}mm; overflow: hidden; page-break-after: always; break-after: page; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  .label { position: absolute; overflow: hidden; background: #fff; color: #000; font-family: 'Invoice Sans', 'Noto Sans Bengali', system-ui, sans-serif; }
  .label > * { position: absolute; margin: 0; left: 0; right: 0; text-align: center; }
  .label .place { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 1mm; }
  .label .code { font-weight: 800; letter-spacing: 0.04em; }
  .label .bc { right: auto; display: block; }
  .label .bc rect { fill: #000; }
</style>
</head>
<body>${body}</body>
</html>`;
  return renderHtmlToPdf(html, { widthMm: pageW, heightMm: pageH });
}
