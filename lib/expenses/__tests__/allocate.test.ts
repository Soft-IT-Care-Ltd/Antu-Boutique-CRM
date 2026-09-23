import { describe, expect, it } from "vitest";

import { allocatePaisa } from "@/lib/expenses/allocate";

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe("ad cost allocation (PRD §4.12)", () => {
  it("equal split hands out every paisa, leftovers to the earliest orders", () => {
    const out = allocatePaisa(100_00, [{ id: "a", valuePaisa: 1 }, { id: "b", valuePaisa: 1 }, { id: "c", valuePaisa: 1 }], "EQUAL");
    expect([...out.values()]).toEqual([3334, 3333, 3333]);
    expect(sum(out)).toBe(100_00);
  });

  it("by value is proportional to order totals and still adds up exactly", () => {
    const out = allocatePaisa(1000_00, [{ id: "small", valuePaisa: 1000_00 }, { id: "big", valuePaisa: 3000_00 }], "BY_VALUE");
    expect(out.get("small")).toBe(250_00);
    expect(out.get("big")).toBe(750_00);

    const odd = allocatePaisa(99_99, [{ id: "x", valuePaisa: 1234_56 }, { id: "y", valuePaisa: 789_01 }, { id: "z", valuePaisa: 45_67 }], "BY_VALUE");
    expect(sum(odd)).toBe(99_99);
  });

  it("by value with only zero-value orders falls back to equal", () => {
    const out = allocatePaisa(10_00, [{ id: "a", valuePaisa: 0 }, { id: "b", valuePaisa: 0 }], "BY_VALUE");
    expect([...out.values()]).toEqual([5_00, 5_00]);
  });

  it("nothing to spread, or nobody to spread it over", () => {
    expect(allocatePaisa(0, [{ id: "a", valuePaisa: 5 }], "EQUAL").get("a")).toBe(0);
    expect(allocatePaisa(500_00, [], "EQUAL").size).toBe(0);
  });
});
