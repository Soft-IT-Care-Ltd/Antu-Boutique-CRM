import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as steadfast from "@/lib/courier/steadfast/client";
import { SteadfastLiveApiDisabledError } from "@/lib/courier/steadfast/client";

// PRD §4.9 (P2.2 decision): with STEADFAST_LIVE_API unset — every developer
// machine — no code path can book a parcel, read a status or pull payouts
// from the real Steadfast API. Only the read-only balance call may go out.
// The REAL client runs here, with fetch stubbed so nothing leaves the box.

const creds = { apiKey: "k", secretKey: "s" };
const payload = { invoice: "AB-2609-0001", recipient_name: "Test", recipient_phone: "01711000000", recipient_address: "Dhaka", cod_amount: 100, delivery_type: 0 as const };

/** Every exported client call except getBalance, as a thunk. Adding a call to the client without listing it here fails the coverage check below. */
const gated: Record<string, () => Promise<unknown>> = {
  createOrder: () => steadfast.createOrder(creds, payload),
  createBulkOrder: () => steadfast.createBulkOrder(creds, [payload]),
  statusByCid: () => steadfast.statusByCid(creds, "123"),
  statusByInvoice: () => steadfast.statusByInvoice(creds, "AB-2609-0001"),
  getPayments: () => steadfast.getPayments(creds),
  getPaymentDetail: () => steadfast.getPaymentDetail(creds, "123"),
};

const original = process.env.STEADFAST_LIVE_API;
const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ status: 200, current_balance: 42 }), { status: 200 }));

beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (original === undefined) delete process.env.STEADFAST_LIVE_API;
  else process.env.STEADFAST_LIVE_API = original;
});

describe("STEADFAST_LIVE_API switch", () => {
  it("covers every exported Steadfast call", () => {
    const exported = Object.entries(steadfast)
      .filter(([, v]) => typeof v === "function" && !/Error$/.test((v as { name: string }).name))
      .map(([k]) => k)
      .sort();
    expect(exported).toEqual([...Object.keys(gated), "getBalance"].sort());
  });

  it.each([undefined, "", "true", "1", "ENABLED", " enabled"])("unset or anything but \"enabled\" (%j): booking, status and payouts are refused before any request", async (value) => {
    if (value === undefined) delete process.env.STEADFAST_LIVE_API;
    else process.env.STEADFAST_LIVE_API = value;
    for (const [name, call] of Object.entries(gated)) {
      await expect(call(), name).rejects.toBeInstanceOf(SteadfastLiveApiDisabledError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the balance check (Test Connection) is the one call that still goes out", async () => {
    delete process.env.STEADFAST_LIVE_API;
    expect(await steadfast.getBalance(creds)).toBe(42);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toMatch(/\/get_balance$/);
  });

  it("with STEADFAST_LIVE_API=enabled (production) the calls do reach fetch", async () => {
    process.env.STEADFAST_LIVE_API = "enabled";
    await steadfast.statusByCid(creds, "123");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
