import { describe, expect, it } from "vitest";

import { buildVariantSku } from "@/lib/catalog/sku";

describe("buildVariantSku", () => {
  it("builds PRD-<code>-<SIZE>-<COLOR>, upper-cased and stripped of non-alphanumerics", () => {
    expect(buildVariantSku("Kurti12", "M", "Maroon")).toBe("PRD-KURTI12-M-MAROON");
    expect(buildVariantSku("3pc-05", "Free", "Navy Blue")).toBe("PRD-3PC05-FREE-NAVYBLUE");
  });

  it("matches the sample SKU shape asserted by the cost-stripping test fixture", () => {
    // lib/auth/__tests__/strip-cost-fields.test.ts hard-codes "PRD-1-M-MAROON"
    // as a realistic sample — prove our generator actually produces that shape.
    expect(buildVariantSku("1", "M", "Maroon")).toBe("PRD-1-M-MAROON");
  });
});
