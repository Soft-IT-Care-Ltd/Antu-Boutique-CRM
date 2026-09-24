import { describe, expect, it } from "vitest";

import { decodeCode128Widths } from "@/lib/barcode/__tests__/decode";
import { code128Widths } from "@/lib/barcode/code128";
import { findLabelStock, fitBarcode, placeTags, renderTagHtml, type TagData } from "@/lib/catalog/price-tag-layout";

const tag = (sku: string): TagData => ({ sku, productName: "Cotton Kurti <b>", sizeName: "M", colorName: "Maroon", price: "1450" });

describe("price tag barcode fit", () => {
  it("uses whole printer dots for every bar", () => {
    const fit = fitBarcode("PRD-KURTI12-M-MAROON", findLabelStock("roll-50x25")!, 203);
    expect(fit.dots).toBeGreaterThanOrEqual(1);
    expect(fit.moduleMm).toBeCloseTo((fit.dots * 25.4) / 203, 10);
    expect(fit.widthMm).toBeLessThanOrEqual(50 - 2);
  });

  it("refuses a SKU that can't fit the label, and allows it on a wider one", () => {
    const sku = "PRD-KURTI12-M-MUSTARDYELLOW";
    expect(fitBarcode(sku, findLabelStock("roll-38x25")!, 203).quality).toBe("too-long");
    expect(fitBarcode(sku, findLabelStock("roll-50x25")!, 203).quality).not.toBe("too-long");
    expect(fitBarcode(sku, findLabelStock("a4-24")!, 600).quality).not.toBe("too-long");
  });

  it("gives short SKUs comfortable bars", () => {
    expect(fitBarcode("PRD-X-M-RED", findLabelStock("a4-24")!, 600).quality).toBe("ok");
  });
});

describe("price tag HTML", () => {
  it("draws exactly the bars of the SKU and escapes the text", () => {
    const sku = "PRD-KURTI12-M-MAROON";
    const html = renderTagHtml(tag(sku), findLabelStock("roll-50x25")!, 203);
    expect(html).toContain(`>${sku}<`);
    expect(html).toContain("Cotton Kurti &lt;b&gt;");
    expect(html).toContain("৳ 1,450");
    // Rebuild the widths from the drawn rects and decode them.
    const rects = [...html.matchAll(/<rect x="(\d+)" y="0" width="(\d+)"/g)].map((m) => ({ x: Number(m[1]), w: Number(m[2]) }));
    const widths: number[] = [];
    rects.forEach((r, i) => {
      widths.push(r.w);
      if (i < rects.length - 1) widths.push(rects[i + 1].x - r.x - r.w);
    });
    expect(widths).toEqual(code128Widths(sku));
    expect(decodeCode128Widths(widths)).toBe(sku);
  });
});

describe("placing tags", () => {
  it("puts one tag per page on a roll", () => {
    const { placed, pages } = placeTags([tag("A"), tag("B")], findLabelStock("roll-50x25")!);
    expect(pages).toBe(2);
    expect(placed.map((p) => p.page)).toEqual([0, 1]);
  });

  it("fills A4 sheets left to right, skipping labels already used", () => {
    const sheet = findLabelStock("a4-24")!;
    const { placed, pages } = placeTags(Array.from({ length: 24 }, () => tag("A")), sheet, 5);
    expect(pages).toBe(2);
    expect(placed[0]).toMatchObject({ page: 0, x: 70, y: 37.125 }); // label 5 = row 2, column 2
    expect(placed[20]).toMatchObject({ page: 1, x: 0, y: 0 });
  });
});
