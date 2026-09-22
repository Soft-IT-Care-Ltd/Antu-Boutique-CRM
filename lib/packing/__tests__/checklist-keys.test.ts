import { describe, expect, it } from "vitest";

import { PACKING_CHECKLIST_KEYS as SERVER_KEYS } from "@/lib/orders/pack";
import { PACKING_CHECKLIST_KEYS as CLIENT_KEYS } from "@/lib/packing/types";

// lib/packing/types.ts deliberately duplicates lib/orders/pack.ts's checklist
// keys (see the comment there) so client components never import a
// "server-only" module. This test is the guard against the two drifting.
describe("packing checklist keys stay in sync between the server and client-safe copies", () => {
  it("lists the exact same keys, in the same order", () => {
    expect(CLIENT_KEYS).toEqual(SERVER_KEYS);
  });
});
