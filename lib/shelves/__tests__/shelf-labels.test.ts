import { describe, expect, it } from "vitest";

import { decodeCode128Widths, drawnBarcode } from "@/lib/barcode/__tests__/decode";
import { code128Widths } from "@/lib/barcode/code128";
import { findLabelStock, fitBarcode, LABEL_STOCKS } from "@/lib/catalog/price-tag-layout";
import { shelfLabelHtml } from "@/lib/shelves/labels";

// C4b/C5 — a shelf label's barcode is Code 128 of the shelf code, on whole
// printer dots. The PDF itself was rasterized at 203 dpi and decoded
// (C5 report); this pins the HTML that PDF is printed from.

describe("shelf label HTML", () => {
  it("draws exactly the shelf code's bars on whole printer dots, on every label size", () => {
    for (const stock of LABEL_STOCKS) {
      const dpi = stock.kind === "ROLL" ? 203 : 600;
      const code = "B-10-12";
      const fit = fitBarcode(code, stock, dpi);
      const html = shelfLabelHtml({ code, locationName: "Mohammadpur <Hub>" }, stock, dpi);
      expect(html).toContain(`>${code}<`);
      expect(html).toContain("Mohammadpur &lt;Hub&gt;");
      const drawn = drawnBarcode(html, fit.dots, dpi);
      expect(drawn.widths, stock.id).toEqual(code128Widths(code));
      expect(decodeCode128Widths(drawn.widths)).toBe(code);
      expect(drawn.boxLeftPx, stock.id).toBe(Math.round(drawn.boxLeftPx));
      expect(drawn.viewBoxWidth).toBe(drawn.boxWidthPx);
      expect(drawn.firstBarDots, stock.id).toBeCloseTo(Math.round(drawn.firstBarDots), 3);
    }
  });

  it("refuses a code too long for the label instead of printing unreadable bars", () => {
    expect(() => shelfLabelHtml({ code: "ABCD-1234-1234-1234", locationName: "Hub" }, findLabelStock("roll-38x25")!, 203)).toThrow(/too long/);
  });
});
