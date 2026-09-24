import { describe, expect, it } from "vitest";

import { decodeCode128Widths } from "@/lib/barcode/__tests__/decode";
import { code128Widths } from "@/lib/barcode/code128";
import { isBarcodeSafeSku } from "@/lib/barcode/scan";
import {
  buildVariantSku,
  COLOR_CODE_PATTERN,
  PRODUCT_CODE_PATTERN,
  productCodeAlternatives,
  SIZE_CODE_PATTERN,
  SKU_MAX_LENGTH,
  suggestColorCode,
  suggestProductCode,
  suggestSizeCode,
} from "@/lib/catalog/codes";
import { findLabelStock, fitBarcode, LABEL_STOCKS } from "@/lib/catalog/price-tag-layout";

describe("short SKUs (PRD §4.2)", () => {
  it("is product + size + colour code, no separators", () => {
    expect(buildVariantSku("K12", "M", "MYL")).toBe("K12MMYL");
    expect(buildVariantSku("S01", "F", "MRN")).toBe("S01FMRN");
  });

  it("so different codes can join the same way — and a clashing product has codes to move to", () => {
    expect(buildVariantSku("K1", "23", "MRN")).toBe(buildVariantSku("K12", "3", "MRN"));
    const next = productCodeAlternatives("K1", "Kurti 1");
    expect(next.slice(0, 3)).toEqual(["K12", "K13", "K14"]);
    expect(next).not.toContain("K1");
    for (const code of next) expect(code).toMatch(PRODUCT_CODE_PATTERN);
  });

  it("suggests the codes staff would write by hand", () => {
    expect(suggestColorCode("Mustard Yellow")).toBe("MYL");
    expect(suggestColorCode("Maroon")).toBe("MRN");
    expect(suggestColorCode("Navy Blue")).toBe("NBL");
    expect(suggestColorCode("Black")).toBe("BLK");
    expect(suggestSizeCode("Free")).toBe("F");
    expect(suggestSizeCode("XXL")).toBe("XXL");
    expect(suggestProductCode("Kurti 12")).toBe("K12");
    expect(suggestProductCode("Jamdani Saree — Classic")).toBe("JSC");
  });

  it("never suggests a code that's taken, and numbers it instead", () => {
    expect(suggestColorCode("Maroon", new Set(["MRN"]))).toBe("MR2");
    expect(suggestProductCode("Kurti 12", new Set(["K12"]))).toBe("K13");
    expect(suggestSizeCode("M", new Set(["M"]))).toBe("M2");
  });

  it("suggestions always fit their pattern, whatever the name", () => {
    for (const name of ["", "A", "Off-White / Cream", "৳ লাল", "123456789", "Very Long Colour Name Indeed"]) {
      const c = suggestColorCode(name);
      const s = suggestSizeCode(name);
      const p = suggestProductCode(name);
      if (c) expect(c).toMatch(COLOR_CODE_PATTERN);
      if (s) expect(s).toMatch(SIZE_CODE_PATTERN);
      if (p) expect(p).toMatch(PRODUCT_CODE_PATTERN);
    }
  });

  it("the longest possible SKU is 9 characters and scans reliably on every label, the smallest included", () => {
    const longest = buildVariantSku("W9Z", "XXL", "MYW");
    expect(longest).toHaveLength(SKU_MAX_LENGTH);
    expect(isBarcodeSafeSku(longest)).toBe(true);
    expect(decodeCode128Widths(code128Widths(longest))).toBe(longest);
    for (const stock of LABEL_STOCKS) {
      for (const dpi of stock.kind === "ROLL" ? [203, 300] : [600]) {
        const fit = fitBarcode(longest, stock, dpi);
        expect(fit.quality, `${stock.id} @ ${dpi} dpi`).toBe("ok");
        expect(fit.moduleMm).toBeGreaterThanOrEqual(0.249);
      }
    }
    // On a 38 mm label at 203 dpi that means 2-dot bars (0.25 mm), not 1-dot.
    expect(fitBarcode(longest, findLabelStock("roll-38x25")!, 203).dots).toBe(2);
  });

  it("anything longer than 9 is refused", () => {
    expect(isBarcodeSafeSku("K12XXLMYL1")).toBe(false);
    expect(fitBarcode("K120XXLMYL", findLabelStock("roll-38x25")!, 203).quality).toBe("too-long");
  });
});
