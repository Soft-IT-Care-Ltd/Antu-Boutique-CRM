import { describe, expect, it } from "vitest";

import { isValidBdPhone, normalizeBdPhone } from "@/lib/customers/phone";

describe("isValidBdPhone", () => {
  it("accepts local and +880/880-prefixed 11-digit mobile numbers", () => {
    expect(isValidBdPhone("01711000004")).toBe(true);
    expect(isValidBdPhone("+8801711000004")).toBe(true);
    expect(isValidBdPhone("8801711000004")).toBe(true);
    expect(isValidBdPhone("017 1100 0004")).toBe(true);
  });

  it("rejects malformed numbers", () => {
    expect(isValidBdPhone("12345")).toBe(false);
    expect(isValidBdPhone("02711000004")).toBe(false); // second digit must be 1
    expect(isValidBdPhone("0171100000")).toBe(false); // too short
    expect(isValidBdPhone("")).toBe(false);
  });
});

describe("normalizeBdPhone", () => {
  it("collapses every accepted shape to the local 11-digit form", () => {
    expect(normalizeBdPhone("01711000004")).toBe("01711000004");
    expect(normalizeBdPhone("+8801711000004")).toBe("01711000004");
    expect(normalizeBdPhone("8801711000004")).toBe("01711000004");
    expect(normalizeBdPhone("017-1100-0004")).toBe("01711000004");
  });
});
