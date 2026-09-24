import { describe, expect, it } from "vitest";

import { decodeCode128Widths as decode } from "@/lib/barcode/__tests__/decode";
import { BarcodeError, CODE128, CODE128_PATTERNS, code128Bars, code128Values, code128Widths } from "@/lib/barcode/code128";
import { isBarcodeSafeSku, looksLikeBanglaKeyboard, normalizeScannedCode } from "@/lib/barcode/scan";

describe("Code 128 symbol table", () => {
  it("has 107 distinct symbols, 11 modules each (STOP 13)", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
    CODE128_PATTERNS.forEach((p, value) => {
      const modules = [...p].reduce((a, w) => a + Number(w), 0);
      expect(modules, `symbol ${value}`).toBe(value === CODE128.STOP ? 13 : 11);
      // Bars and spaces are 1–4 modules; a symbol's bars always total an even count.
      const bars = [...p].filter((_, k) => k % 2 === 0).reduce((a, w) => a + Number(w), 0);
      expect(bars % 2, `symbol ${value} bar parity`).toBe(0);
    });
  });
});

describe("code128 encode → decode", () => {
  const cases = [
    "PRD-KURTI12-XL-MAROON",
    "PRD-SAREE01-FREE-RED",
    "PRD-3PC05-M-BOTTLEGREEN",
    "PRD-WEST02-S-BLACK-2",
    "123456",
    "12345",
    "AB-2609-0001",
    "PRD-X-L-REDD123456",
    "0",
    "A",
    "99-99",
  ];
  for (const text of cases) {
    it(`round-trips ${text}`, () => {
      expect(decode(code128Widths(text))).toBe(text);
    });
  }

  it("uses code set C for long digit runs, so numbers stay narrow", () => {
    expect(code128Values("123456")[0]).toBe(CODE128.START_C);
    expect(code128Values("PRD-123456-X")).toContain(CODE128.CODE_C);
    expect(code128Widths("12345678").length).toBeLessThan(code128Widths("ABCDEFGH").length);
  });

  it("starts and ends every barcode with a bar", () => {
    const { bars, modules } = code128Bars("PRD-KURTI12-XL-MAROON");
    expect(bars[0].x).toBe(0);
    const last = bars.at(-1)!;
    expect(last.x + last.width).toBe(modules);
    // start + 21 characters + check, 11 modules each, plus the 13-module stop.
    expect(modules).toBe(11 * 23 + 13);
  });

  it("refuses text a barcode can't carry", () => {
    expect(() => code128Values("")).toThrow(BarcodeError);
    expect(() => code128Values("কুর্তি")).toThrow(BarcodeError);
  });
});

describe("POS scan normalisation", () => {
  it("reads back what the tag encodes, whatever the scanner adds", () => {
    expect(normalizeScannedCode("PRD-KURTI12-XL-MAROON")).toBe("PRD-KURTI12-XL-MAROON");
    expect(normalizeScannedCode("  PRD-KURTI12-XL-MAROON\r\n")).toBe("PRD-KURTI12-XL-MAROON");
    expect(normalizeScannedCode("\tPRD-KURTI12-XL-MAROON")).toBe("PRD-KURTI12-XL-MAROON");
    // Caps Lock on: the scanner's keyboard emulation inverts letter case.
    expect(normalizeScannedCode("prd-kurti12-xl-maroon")).toBe("PRD-KURTI12-XL-MAROON");
  });

  it("rejects what can't be a SKU", () => {
    expect(normalizeScannedCode("red kurti")).toBeNull();
    expect(normalizeScannedCode("")).toBeNull();
    expect(normalizeScannedCode("PRD_KURTI")).toBeNull();
  });

  it("only allows SKUs a barcode and a scanner round-trip exactly", () => {
    expect(isBarcodeSafeSku("PRD-KURTI12-XL-MAROON")).toBe(true);
    expect(isBarcodeSafeSku("prd-kurti")).toBe(false);
    expect(isBarcodeSafeSku("PRD KURTI")).toBe(false);
    expect(isBarcodeSafeSku("PRD-কুর্তি")).toBe(false);
  });

  it("spots a Bangla keyboard layout eating the scan", () => {
    expect(looksLikeBanglaKeyboard("প্রদ-কুর্তি")).toBe(true);
    expect(looksLikeBanglaKeyboard("PRD-KURTI")).toBe(false);
  });

  it("every normalised scan of a tag decodes to a barcode-safe SKU", () => {
    for (const sku of ["PRD-KURTI12-XL-MAROON", "PRD-3PC05-M-BOTTLEGREEN"]) {
      const scanned = decode(code128Widths(sku));
      expect(normalizeScannedCode(scanned)).toBe(sku);
    }
  });
});
