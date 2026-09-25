import { describe, expect, it } from "vitest";

import { dhakaDayStartOf, dhakaLocalToUtc, followUpState, utcToDhakaLocal } from "@/lib/leads/dates";
import { leadConvertError, leadStatusMoveError, statusAfterScheduling } from "@/lib/leads/status";

describe("lead status funnel (PRD §4.5)", () => {
  it("moves freely between the open stages and to LOST", () => {
    expect(leadStatusMoveError("NEW", "NEGOTIATING")).toBeNull();
    expect(leadStatusMoveError("NEGOTIATING", "FOLLOW_UP")).toBeNull();
    expect(leadStatusMoveError("CONTACTED", "LOST")).toBeNull();
  });

  it("reopens a lost lead, but never picks CONVERTED by hand or moves a converted lead", () => {
    expect(leadStatusMoveError("LOST", "FOLLOW_UP")).toBeNull();
    expect(leadStatusMoveError("NEGOTIATING", "CONVERTED")).toMatch(/order is placed/);
    expect(leadStatusMoveError("CONVERTED", "LOST")).toMatch(/closed/);
    expect(leadStatusMoveError("NEW", "NEW")).toMatch(/already/);
  });

  it("scheduling a follow-up moves NEW/CONTACTED to FOLLOW_UP and leaves later stages alone", () => {
    expect(statusAfterScheduling("NEW")).toBe("FOLLOW_UP");
    expect(statusAfterScheduling("CONTACTED")).toBe("FOLLOW_UP");
    expect(statusAfterScheduling("NEGOTIATING")).toBe("NEGOTIATING");
  });

  it("converts anything but an already-converted lead — a lost lead that comes back included", () => {
    expect(leadConvertError("LOST")).toBeNull();
    expect(leadConvertError("CONVERTED")).toMatch(/already/);
  });
});

describe("follow-up times are Dhaka time (UTC+6, no DST)", () => {
  it("round-trips a typed Dhaka time through UTC", () => {
    const utc = dhakaLocalToUtc("2026-09-25T16:30");
    expect(utc.toISOString()).toBe("2026-09-25T10:30:00.000Z");
    expect(utcToDhakaLocal(utc)).toBe("2026-09-25T16:30");
  });

  it("finds the Dhaka day an instant falls in, across the UTC date line", () => {
    // 20:00 UTC on the 24th is 02:00 on the 25th in Dhaka.
    expect(dhakaDayStartOf(new Date("2026-09-24T20:00:00Z")).toISOString()).toBe("2026-09-24T18:00:00.000Z");
    expect(dhakaDayStartOf(new Date("2026-09-24T20:00:00Z"), 1).toISOString()).toBe("2026-09-25T18:00:00.000Z");
  });

  it("is overdue once past, 'today' until Dhaka midnight, upcoming after", () => {
    const now = new Date("2026-09-25T10:00:00Z"); // 16:00 Dhaka
    expect(followUpState("2026-09-25T09:59:00Z", now)).toBe("overdue");
    expect(followUpState("2026-09-25T17:59:00Z", now)).toBe("today"); // 23:59 Dhaka
    expect(followUpState("2026-09-25T18:00:00Z", now)).toBe("upcoming"); // midnight
  });
});
