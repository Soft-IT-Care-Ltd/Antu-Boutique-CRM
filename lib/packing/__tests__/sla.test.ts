import { describe, expect, it } from "vitest";

import { hoursSince, isOverdue } from "@/lib/packing/sla";

describe("packing SLA colouring (PRD §4.8)", () => {
  it("computes fractional hours since a given timestamp", () => {
    const now = new Date("2026-01-02T12:00:00Z");
    const createdAt = new Date("2026-01-02T06:00:00Z");
    expect(hoursSince(createdAt, now)).toBe(6);
  });

  it("is overdue only once elapsed hours exceed the SLA threshold", () => {
    const now = new Date("2026-01-02T12:00:00Z");
    const justUnder = new Date("2026-01-01T13:00:00Z"); // 23h ago
    const justOver = new Date("2026-01-01T11:00:00Z"); // 25h ago

    expect(isOverdue(justUnder, 24, now)).toBe(false);
    expect(isOverdue(justOver, 24, now)).toBe(true);
  });
});
