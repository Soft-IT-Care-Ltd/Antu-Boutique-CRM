import { describe, expect, it } from "vitest";

import { decodeCode128Widths, drawnBarcode } from "@/lib/barcode/__tests__/decode";
import { code128Widths } from "@/lib/barcode/code128";
import { findLabelStock, fitBarcode, placeTags, renderTagHtml, type TagData } from "@/lib/catalog/price-tag-layout";

const tag = (sku: string): TagData => ({ sku, productName: "Cotton Kurti <b>", sizeName: "M", colorName: "Maroon", price: "1450" });

describe("price tag barcode fit", () => {
  it("uses whole printer dots for every bar", () => {
    const fit = fitBarcode("K12MMRN", findLabelStock("roll-38x25")!, 203);
    expect(fit.dots).toBeGreaterThanOrEqual(1);
    expect(fit.moduleMm).toBeCloseTo((fit.dots * 25.4) / 203, 10);
    expect(fit.widthMm).toBeLessThanOrEqual(38 - 0.8);
  });

  it("refuses a code too long for reliable bars on the label, and allows it on a wider one", () => {
    const long = "K12XXLMYL00"; // 11 characters — more than a SKU may have
    expect(fitBarcode(long, findLabelStock("roll-38x25")!, 203).quality).toBe("too-long");
    expect(fitBarcode(long, findLabelStock("roll-60x40")!, 203).quality).toBe("ok");
    expect(fitBarcode(long, findLabelStock("a4-24")!, 600).quality).toBe("ok");
  });

  it("gives short SKUs comfortable bars", () => {
    expect(fitBarcode("PRD-X-M-RED", findLabelStock("a4-24")!, 600).quality).toBe("ok");
  });
});

describe("price tag HTML", () => {
  it("draws exactly the bars of the SKU, on whole printer dots, and escapes the text", () => {
    const sku = "K12MMRN";
    const stock = findLabelStock("roll-50x25")!;
    const html = renderTagHtml(tag(sku), stock, 203);
    expect(html).toContain(`>${sku}<`);
    expect(html).toContain("Cotton Kurti &lt;b&gt;");
    expect(html).toContain("৳ 1,450");
    const drawn = drawnBarcode(html, fitBarcode(sku, stock, 203).dots, 203);
    expect(drawn.widths).toEqual(code128Widths(sku));
    expect(decodeCode128Widths(drawn.widths)).toBe(sku);
    // Chrome snaps an <svg> box to whole CSS px; the box is already there, and unscaled.
    expect(drawn.boxLeftPx).toBe(Math.round(drawn.boxLeftPx));
    expect(drawn.viewBoxWidth).toBe(drawn.boxWidthPx);
    expect(drawn.firstBarDots).toBeCloseTo(Math.round(drawn.firstBarDots), 3);
  });

  it("keeps the bars on the page's dot grid for a label in the middle of an A4 sheet", () => {
    const sheet = findLabelStock("a4-24")!;
    const origin = { x: 70, y: 37.125 };
    const html = renderTagHtml(tag("K12MMRN"), sheet, 600, origin);
    const drawn = drawnBarcode(html, fitBarcode("K12MMRN", sheet, 600).dots, 600, origin.x);
    expect(drawn.boxLeftPx).toBeCloseTo(Math.round(drawn.boxLeftPx), 3);
    expect(drawn.firstBarDots).toBeCloseTo(Math.round(drawn.firstBarDots), 3);
    expect(decodeCode128Widths(drawn.widths)).toBe("K12MMRN");
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
