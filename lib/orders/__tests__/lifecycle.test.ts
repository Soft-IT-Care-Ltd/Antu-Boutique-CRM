import { describe, expect, it } from "vitest";

import { isDedicatedMove, isTransitionAllowed, nextLegalStatuses, nextSelectableStatuses, STATUSES_REQUIRING_DEDICATED_FLOW } from "@/lib/orders/lifecycle";

describe("order status transition graph (PRD §4.6 + §6 rule 1)", () => {
  it("allows the primary funnel in order", () => {
    expect(isTransitionAllowed("LEAD", "CONFIRMED")).toBe(true);
    expect(isTransitionAllowed("CONFIRMED", "PACKED")).toBe(true);
    expect(isTransitionAllowed("PACKED", "HANDED_TO_COURIER")).toBe(true);
    expect(isTransitionAllowed("HANDED_TO_COURIER", "IN_TRANSIT")).toBe(true);
    expect(isTransitionAllowed("IN_TRANSIT", "DELIVERED")).toBe(true);
    expect(isTransitionAllowed("DELIVERED", "COMPLETED")).toBe(true);
  });

  it("rejects skipping stages", () => {
    expect(isTransitionAllowed("LEAD", "PACKED")).toBe(false);
    expect(isTransitionAllowed("CONFIRMED", "DELIVERED")).toBe(false);
    expect(isTransitionAllowed("LEAD", "COMPLETED")).toBe(false);
  });

  it("rejects moving out of a terminal status", () => {
    expect(nextLegalStatuses("CANCELLED")).toEqual([]);
    expect(nextLegalStatuses("REFUNDED")).toEqual([]);
    expect(isTransitionAllowed("CANCELLED", "CONFIRMED")).toBe(false);
  });

  it("allows cancelling from the pre-packed states", () => {
    expect(isTransitionAllowed("LEAD", "CANCELLED")).toBe(true);
    expect(isTransitionAllowed("CONFIRMED", "CANCELLED")).toBe(true);
  });

  it("PACKED is a legal graph edge but flagged as needing its own flow, not the generic status route", () => {
    expect(isTransitionAllowed("CONFIRMED", "PACKED")).toBe(true);
    expect(STATUSES_REQUIRING_DEDICATED_FLOW).toContain("PACKED");
  });

  it("P3.2: a customer's return, an exchange and a refund each go through their own flow, never the generic status change", () => {
    // A customer return of goods they have needs a reason and an approval.
    expect(isDedicatedMove("DELIVERED", "RETURNED")).toBe(true);
    expect(isDedicatedMove("COMPLETED", "RETURNED")).toBe(true);
    // A courier return (still in transit) stays a plain move.
    expect(isDedicatedMove("IN_TRANSIT", "RETURNED")).toBe(false);
    expect(isDedicatedMove("DELIVERED", "EXCHANGE_REQUESTED")).toBe(true);
    expect(isDedicatedMove("RETURNED", "REFUNDED")).toBe(true);
    expect(nextSelectableStatuses("EXCHANGE_REQUESTED")).toEqual([]);
    expect(nextSelectableStatuses("DELIVERED")).toEqual(["COMPLETED"]);
    // An order mid-exchange can't be cancelled: the customer has the goods.
    expect(isTransitionAllowed("EXCHANGE_REQUESTED", "CANCELLED")).toBe(false);
  });
});
