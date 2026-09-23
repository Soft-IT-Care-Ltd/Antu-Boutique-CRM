import { readFileSync } from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/courier/steadfast/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/courier/steadfast/client")>();
  return { ...actual, getBalance: vi.fn(), createOrder: vi.fn(), createBulkOrder: vi.fn(), statusByCid: vi.fn(), statusByInvoice: vi.fn() };
});

import { GET as cronGET } from "@/app/api/cron/steadfast-sync/route";
import { POST as webhookPOST } from "@/app/api/webhooks/steadfast/route";

// proxy.ts imports next-auth, which can't load under plain Node/vitest (same
// reason lib/auth/permissions.ts avoids it) — so read its matcher from source.
function proxyMatcher(): RegExp {
  const source = readFileSync(path.resolve(__dirname, "../../../proxy.ts"), "utf8");
  const m = /matcher:\s*\["([^"]+)"\]/.exec(source);
  if (!m) throw new Error("proxy.ts matcher not found");
  return new RegExp(`^${m[1]}$`);
}

// The two machine-to-machine endpoints: no session, their own Bearer secret.
describe("cron + webhook routes authenticate themselves", () => {
  it("cron: 401 without, or with the wrong, CRON_SECRET", async () => {
    const none = await cronGET(new NextRequest("http://localhost/api/cron/steadfast-sync"));
    expect(none.status).toBe(401);
    const wrong = await cronGET(new NextRequest("http://localhost/api/cron/steadfast-sync", { headers: { authorization: "Bearer not-the-secret" } }));
    expect(wrong.status).toBe(401);
  });

  it("cron: fails closed when CRON_SECRET is unset, even for an empty bearer", async () => {
    const original = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "";
    try {
      const res = await cronGET(new NextRequest("http://localhost/api/cron/steadfast-sync", { headers: { authorization: "Bearer " } }));
      expect(res.status).toBe(401);
    } finally {
      process.env.CRON_SECRET = original;
    }
  });

  it("webhook: 401 with no or a wrong token", async () => {
    const body = JSON.stringify({ notification_type: "delivery_status", consignment_id: 1, status: "delivered" });
    const none = await webhookPOST(new NextRequest("http://localhost/api/webhooks/steadfast", { method: "POST", body }));
    expect(none.status).toBe(401);
    const wrong = await webhookPOST(new NextRequest("http://localhost/api/webhooks/steadfast", { method: "POST", body, headers: { authorization: "Bearer nope" } }));
    expect(wrong.status).toBe(401);
  });

  it("the login proxy never intercepts /api/webhooks or /api/cron (Steadfast and cron have no session)", () => {
    const matcher = proxyMatcher();
    expect(matcher.test("/api/webhooks/steadfast")).toBe(false);
    expect(matcher.test("/api/cron/steadfast-sync")).toBe(false);
    expect(matcher.test("/api/courier/shipments")).toBe(true);
    expect(matcher.test("/courier")).toBe(true);
  });
});
