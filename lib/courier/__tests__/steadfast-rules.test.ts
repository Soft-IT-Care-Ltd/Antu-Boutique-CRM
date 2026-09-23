import { describe, expect, it } from "vitest";

import { estimateCourierCost, trackingUrlFromCode } from "@/lib/courier/constants";
import { buildSteadfastPayload, type SteadfastSendableOrder } from "@/lib/courier/steadfast/payload";
import {
  DELIVERY_CHARGE_KEY,
  findNumericField,
  mapSteadfastStatus,
  normalizeSteadfastPhone,
  parseSteadfastTimestamp,
  resolveFinalWebhookStatus,
} from "@/lib/courier/steadfast/status";

describe("mapSteadfastStatus (STEADFAST_INTEGRATION.md §3B, case-insensitive)", () => {
  it("maps every documented webhook + polling status", () => {
    const table: [string, string | null, string | null | undefined, boolean][] = [
      ["in_review", null, undefined, false],
      ["pending", "IN_TRANSIT", "PENDING", false],
      ["hold", "IN_TRANSIT", "PENDING", false],
      ["delivered_approval_pending", "IN_TRANSIT", "DELIVERY_APPROVAL_PENDING", false],
      ["partial_delivered_approval_pending", "IN_TRANSIT", "PARTIAL_DELIVERY_APPROVAL_PENDING", false],
      ["cancelled_approval_pending", "IN_TRANSIT", "RETURN_APPROVAL_PENDING", false],
      ["delivered", "DELIVERED", null, true],
      ["partial_delivered", "PARTIAL_DELIVERED", null, true],
      ["cancelled", "RETURNED", null, true],
      ["unknown", null, undefined, false],
      ["unknown_approval_pending", null, undefined, false],
    ];
    for (const [raw, to, sub, final] of table) {
      const m = mapSteadfastStatus(raw);
      expect(m.to, raw).toBe(to);
      expect(m.subStatus, raw).toBe(sub);
      expect(m.final, raw).toBe(final);
      expect(m.recognized, raw).toBe(true);
    }
  });

  it('treats "Delivered", " DELIVERED " and "delivered" the same', () => {
    for (const raw of ["Delivered", " DELIVERED ", "delivered"]) {
      expect(mapSteadfastStatus(raw)).toMatchObject({ normalized: "delivered", to: "DELIVERED", final: true });
    }
  });

  it("flags hold as on-hold and unknown/undocumented statuses for attention, never moving the order", () => {
    expect(mapSteadfastStatus("hold").onHold).toBe(true);
    expect(mapSteadfastStatus("unknown")).toMatchObject({ to: null, needsAttention: true });
    expect(mapSteadfastStatus("lost_in_space")).toMatchObject({ to: null, needsAttention: true, recognized: false });
    expect(mapSteadfastStatus(null)).toMatchObject({ to: null, recognized: false });
  });
});

describe("resolveFinalWebhookStatus (CORRECTIONS Round 2 §2.6)", () => {
  it("finalizes only when the status API agrees", () => {
    expect(resolveFinalWebhookStatus("Delivered", "delivered")).toEqual({ status: "Delivered", attentionReason: null });
    expect(resolveFinalWebhookStatus("cancelled", "cancelled")).toEqual({ status: "cancelled", attentionReason: null });
  });

  it("holds IN_TRANSIT with the approval sub-status when the API says *_approval_pending", () => {
    expect(resolveFinalWebhookStatus("delivered", "delivered_approval_pending")).toEqual({ status: "delivered_approval_pending", attentionReason: null });
    expect(resolveFinalWebhookStatus("cancelled", "cancelled_approval_pending")).toEqual({ status: "cancelled_approval_pending", attentionReason: null });
    expect(resolveFinalWebhookStatus("partial_delivered", "partial_delivered_approval_pending").status).toBe("partial_delivered_approval_pending");
  });

  it("never finalizes on an unverified webhook: API down or disagreeing → hold at approval-pending and flag", () => {
    const down = resolveFinalWebhookStatus("delivered", null, "timeout");
    expect(down.status).toBe("delivered_approval_pending");
    expect(down.attentionReason).toMatch(/could not confirm/);
    const disagrees = resolveFinalWebhookStatus("cancelled", "pending");
    expect(disagrees.status).toBe("cancelled_approval_pending");
    expect(disagrees.attentionReason).toMatch(/status API says "pending"/);
  });

  it("passes non-final webhooks through untouched", () => {
    expect(resolveFinalWebhookStatus("pending", null)).toEqual({ status: "pending", attentionReason: null });
  });
});

describe("parseSteadfastTimestamp (CORRECTIONS Round 2 §2.5)", () => {
  it("reads zone-less strings as Asia/Dhaka local time and returns the UTC instant", () => {
    expect(parseSteadfastTimestamp("2025-03-02 12:45:30")?.toISOString()).toBe("2025-03-02T06:45:30.000Z");
    // Crosses midnight backwards into the previous UTC day.
    expect(parseSteadfastTimestamp("2025-03-02 03:10:00")?.toISOString()).toBe("2025-03-01T21:10:00.000Z");
    expect(parseSteadfastTimestamp("2025-03-02T12:45")?.toISOString()).toBe("2025-03-02T06:45:00.000Z");
  });

  it("does not depend on the server's TZ (this repo sets TZ=Asia/Dhaka; a VPS runs UTC)", () => {
    // new Date("2025-03-02 12:45:30") would give a different answer per TZ — the parser never uses it for zone-less input.
    const parsed = parseSteadfastTimestamp("2025-03-02 12:45:30")!;
    expect(parsed.getTime()).toBe(Date.UTC(2025, 2, 2, 6, 45, 30));
  });

  it("passes explicit zones and epochs through; rejects garbage", () => {
    expect(parseSteadfastTimestamp("2025-03-02T12:45:30Z")?.toISOString()).toBe("2025-03-02T12:45:30.000Z");
    expect(parseSteadfastTimestamp("2025-03-02T12:45:30+06:00")?.toISOString()).toBe("2025-03-02T06:45:30.000Z");
    expect(parseSteadfastTimestamp(1_740_897_930_000)?.getTime()).toBe(1_740_897_930_000);
    expect(parseSteadfastTimestamp("yesterday")).toBeNull();
    expect(parseSteadfastTimestamp("")).toBeNull();
    expect(parseSteadfastTimestamp(null)).toBeNull();
  });
});

describe("normalizeSteadfastPhone (acceptance #4)", () => {
  it("normalizes +880 / 880 / 00880 / spaced / dashed forms to 01XXXXXXXXX", () => {
    for (const raw of ["+8801711000004", "8801711000004", "008801711000004", "01711-000004", "+880 1711 000 004", "01711000004"]) {
      expect(normalizeSteadfastPhone(raw), raw).toBe("01711000004");
    }
  });
  it("blocks 10-digit, too-long and non-mobile numbers", () => {
    for (const raw of ["0171100000", "017110000045", "01211000004", "+44 7700 900123", "", null]) {
      expect(normalizeSteadfastPhone(raw), String(raw)).toBeNull();
    }
  });
});

describe("estimateCourierCost (base covers the first kg)", () => {
  const rate = { baseRate: 60, perKgRate: 20 };
  it("charges base up to 1 kg and per-kg for each further started kg", () => {
    expect(estimateCourierCost(rate, null)).toBe(60);
    expect(estimateCourierCost(rate, 250)).toBe(60);
    expect(estimateCourierCost(rate, 1000)).toBe(60);
    expect(estimateCourierCost(rate, 1001)).toBe(80);
    expect(estimateCourierCost(rate, 2600)).toBe(100);
  });
  it("is null with no rate configured", () => {
    expect(estimateCourierCost(null, 500)).toBeNull();
  });
});

describe("raw payload mining", () => {
  it("finds delivery_charge without catching cod_charge", () => {
    expect(findNumericField({ cod_charge: 15, data: { delivery_charge: "110.00" } }, DELIVERY_CHARGE_KEY)).toBe(110);
    expect(findNumericField({ cod_charge: 15 }, DELIVERY_CHARGE_KEY)).toBeNull();
  });
  it("builds the public tracking link from a tracking code", () => {
    expect(trackingUrlFromCode("15BAEB8A")).toBe("https://steadfast.com.bd/tl/15BAEB8A");
    expect(trackingUrlFromCode(null)).toBeNull();
  });
});

describe("buildSteadfastPayload — one person per order", () => {
  const base: SteadfastSendableOrder = {
    orderNo: "AB-2609-0042",
    dueAmount: "1510.00",
    deliveryNote: "Call before coming",
    customer: { name: "Farzana Akter", phone: "+8801911223344", altPhone: "01812345678", addressDetail: "House 12, Road 5", thana: "Mirpur", district: "Dhaka" },
    items: [
      { qty: 2, productName: "Embroidered Kurti", sizeName: "M", colorName: "Maroon" },
      { qty: 1, productName: "Jamdani Saree — Classic", sizeName: "Free", colorName: "Navy Blue" },
    ],
  };

  it("maps the customer as the recipient, with size and colour in the item description", () => {
    const res = buildSteadfastPayload(base);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload).toEqual({
      invoice: "AB-2609-0042",
      recipient_name: "Farzana Akter",
      recipient_phone: "01911223344",
      alternative_phone: "01812345678",
      recipient_address: "House 12, Road 5, Mirpur, Dhaka",
      cod_amount: 1510,
      note: "Call before coming",
      item_description: "Embroidered Kurti (M / Maroon) ×2, Jamdani Saree — Classic (Free / Navy Blue) ×1",
      delivery_type: 0,
      total_lot: 1,
    });
  });

  it("never sends the internal staff note — the payload type has no path to it, and note is only deliveryNote", () => {
    const withInternal = { ...base, internalNote: "Has refused COD before — SECRET", deliveryNote: null } as SteadfastSendableOrder;
    const res = buildSteadfastPayload(withInternal);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.note).toBeUndefined();
    expect(JSON.stringify(res.payload)).not.toContain("SECRET");
  });

  it("omits alternative_phone when it is invalid or the same number", () => {
    const invalid = buildSteadfastPayload({ ...base, customer: { ...base.customer, altPhone: "12345" } });
    const same = buildSteadfastPayload({ ...base, customer: { ...base.customer, altPhone: "01911-223344" } });
    expect(invalid.ok && invalid.payload.alternative_phone).toBeUndefined();
    expect(same.ok && same.payload.alternative_phone).toBeUndefined();
  });

  it("blocks a 10-digit phone and a missing address with a clear error", () => {
    const badPhone = buildSteadfastPayload({ ...base, customer: { ...base.customer, phone: "0191122334" } });
    expect(badPhone).toMatchObject({ ok: false });
    expect(!badPhone.ok && badPhone.error).toMatch(/11-digit BD mobile/);
    const noAddress = buildSteadfastPayload({ ...base, customer: { ...base.customer, addressDetail: null, thana: " ", district: null } });
    expect(noAddress).toEqual({ ok: false, error: "Delivery address is missing" });
  });

  it("never sends a negative COD (overpaid order) and keeps size/colour when names are long", () => {
    const overpaid = buildSteadfastPayload({ ...base, dueAmount: -200 });
    expect(overpaid.ok && overpaid.payload.cod_amount).toBe(0);
    const long = buildSteadfastPayload({
      ...base,
      items: [{ qty: 1, productName: "A very very long boutique product name that goes on and on forever", sizeName: "XL", colorName: "Emerald Green" }],
    });
    expect(long.ok && long.payload.item_description).toMatch(/\(XL \/ Emerald Green\) ×1$/);
  });
});
