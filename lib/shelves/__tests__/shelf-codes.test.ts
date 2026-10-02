import { describe, expect, it } from "vitest";

import { normalizeScannedCode } from "@/lib/barcode/scan";
import { compareShelfCodes, generateShelfCodes, normalizeShelfCode } from "@/lib/shelves/constants";

// C4b — a scan box at a shelf location takes dress tags and shelf labels
// without a mode switch: a shelf code always has a hyphen, a SKU never does.

describe("shelf codes", () => {
  it("reads typed or scanned shelf codes, and nothing that could be a SKU", () => {
    expect(normalizeShelfCode(" a-2-3\r\n")).toBe("A-2-3");
    expect(normalizeShelfCode("B-1")).toBe("B-1");
    expect(normalizeShelfCode("RACK-10-2")).toBe("RACK-10-2");
    for (const notAShelf of ["A23", "A--2", "-A-2", "A-2-", "ABCDE-1", "A-1-2-3-4", "A_1", "ক-১"]) expect(normalizeShelfCode(notAShelf)).toBeNull();
    // Every valid shelf code is refused as a SKU, and every SKU as a shelf code.
    for (const code of generateShelfCodes("A", 3, 3)) expect(normalizeScannedCode(code)).toBeNull();
    expect(normalizeShelfCode("KUR0102")).toBeNull();
  });

  it("generates a whole rack, and sorts shelves naturally", () => {
    expect(generateShelfCodes("A", 2, 2)).toEqual(["A-1-1", "A-1-2", "A-2-1", "A-2-2"]);
    expect(generateShelfCodes("B", 3, 0)).toEqual(["B-1", "B-2", "B-3"]);
    expect(["A-2-10", "A-2-9", "A-10-1", "B-1"].sort(compareShelfCodes)).toEqual(["A-2-9", "A-2-10", "A-10-1", "B-1"]);
  });
});
