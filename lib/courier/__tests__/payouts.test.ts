import { describe, expect, it } from "vitest";

import { parseStatementCsv } from "@/lib/courier/payouts/csv";
import { completeStatementAmounts, computeNetReceivable, statementIdentityHolds, withinTolerance } from "@/lib/courier/payouts/net";
import { normalizePayoutStatus, parsePayoutDetail, parsePayoutList } from "@/lib/courier/payouts/parse";

// The real Steadfast payout envelope Gift Valy captured in production (Round 2 §2.1).
const REAL_LIST = {
  status: 1,
  alertClass: "success",
  message: "Payments",
  payments: [
    {
      payment_id: "SFC-30820783",
      amount: 2200,
      method: "Bank",
      due_bills: 135,
      paid_bills: 0,
      charges: 21,
      total: 2044,
      status_label: "paid",
      created_at: "2026-07-20 10:00:00",
      ready_at: "2026-07-21 18:00:00",
      paid_at: "2026-07-22 15:10:00",
    },
    { payment_id: "SFC-30820999", amount: 990, due_bills: 60, charges: 9, total: 921, status_label: "unpaid", created_at: "2026-07-23 09:00:00" },
  ],
};

describe("Steadfast payout parsing (real production envelope)", () => {
  it("reads the SFC- string id, the gross/charges/net figures and the Dhaka paid_at", () => {
    const [paid, unpaid] = parsePayoutList(REAL_LIST);
    expect(paid).toMatchObject({
      reference: "SFC-30820783",
      detailId: "30820783",
      status: "PAID",
      grossAmount: 2200,
      deliveryCharge: 135,
      codCharge: 21,
      netAmount: 2044,
    });
    // 15:10 Asia/Dhaka = 09:10 UTC (Round 2 §2.5).
    expect(paid.date?.toISOString()).toBe("2026-07-22T09:10:00.000Z");
    expect(unpaid.status).toBe("PROCESSING");
    expect(unpaid.date?.toISOString()).toBe("2026-07-23T03:00:00.000Z");
  });

  it("only an explicit paid state counts as PAID — nothing ambiguous moves money", () => {
    for (const s of ["paid", "Paid", "completed", "disbursed"]) expect(normalizePayoutStatus(s)).toBe("PAID");
    for (const s of ["unpaid", "processing", "ready", "", null]) expect(normalizePayoutStatus(s)).toBe("PROCESSING");
  });

  it("drops rows without a usable id, and tolerates a data-wrapped envelope", () => {
    expect(parsePayoutList({ data: { payments: [{ payment_id: "SFC-1", amount: 10, status_label: "paid" }, { amount: 5 }] } })).toHaveLength(1);
    expect(parsePayoutList({ payments: [] })).toEqual([]);
    expect(parsePayoutList(null)).toEqual([]);
  });

  it("reads the detail: payment figures + the cleared consignments (no per-parcel charge)", () => {
    const detail = parsePayoutDetail({
      payment: REAL_LIST.payments[0],
      consignments: [
        { consignment_id: 1234567, invoice: "AB-2609-0012", tracking_code: "15BAEB8A", cod_amount: 1500, status: "delivered" },
        { consignment_id: 1234568, invoice: "AB-2609-0013", tracking_code: "15BAEB8B", cod_amount: "700.00", status: "delivered" },
      ],
    });
    expect(detail.payout?.reference).toBe("SFC-30820783");
    expect(detail.consignments).toEqual([
      expect.objectContaining({ consignmentId: "1234567", invoice: "AB-2609-0012", codAmount: 1500, deliveryCharge: null }),
      expect.objectContaining({ consignmentId: "1234568", codAmount: 700 }),
    ]);
  });
});

describe("net receivable (Round 2 §2.7)", () => {
  it("COD fee is 1% of COD minus the delivery charge, and matches the real invoice within ৳2", () => {
    const net = computeNetReceivable({ codAmount: 2200, courierCostActual: 135 });
    expect(net).toEqual({ deliveryCharge: 135, codFee: 20.65, deduction: 155.65, netReceivable: 2044.35, chargeKnown: true });
    expect(withinTolerance(2044, net.netReceivable)).toBe(true); // their invoice: total 2044
    expect(withinTolerance(2040, net.netReceivable)).toBe(false);
  });

  it("falls back to our estimate when the courier hasn't reported a charge, and never goes below zero COD", () => {
    expect(computeNetReceivable({ codAmount: 1000, courierCostEstimate: 60 })).toMatchObject({ deliveryCharge: 60, chargeKnown: false, codFee: 9.4, netReceivable: 930.6 });
    expect(computeNetReceivable({ codAmount: 0, courierCostActual: 75 })).toMatchObject({ codFee: 0, netReceivable: -75 });
  });

  it("completes a statement's missing side and checks gross − charges = net", () => {
    expect(completeStatementAmounts({ grossAmount: 2200, deliveryCharge: 135, codCharge: 21 }, [])).toEqual({ grossAmount: 2200, deliveryCharge: 135, codCharge: 21, netAmount: 2044 });
    expect(completeStatementAmounts({ netAmount: 2044 }, [{ codAmount: 1500, deliveryCharge: 60 }, { codAmount: 700, deliveryCharge: 75, codCharge: 21 }])).toEqual({
      grossAmount: 2200,
      deliveryCharge: 135,
      codCharge: 21,
      netAmount: 2044,
    });
    expect(statementIdentityHolds({ grossAmount: 2200, deliveryCharge: 135, codCharge: 21, netAmount: 2044 })).toBe(true);
    expect(statementIdentityHolds({ grossAmount: 2200, deliveryCharge: 135, codCharge: 21, netAmount: 2000 })).toBe(false);
  });
});

describe("courier statement CSV", () => {
  it("accepts loose headers, quotes, taka signs and thousands separators", () => {
    const csv = 'Consignment ID,Order No,"COD Amount",Delivery Charge\r\n1234567,AB-2609-0012,"৳ 1,510",60\n,AB-2609-0013,700.50,\n';
    expect(parseStatementCsv(csv)).toEqual({
      errors: [],
      lines: [
        { consignmentId: "1234567", invoice: "AB-2609-0012", codAmount: 1510, deliveryCharge: 60, codCharge: null },
        { consignmentId: null, invoice: "AB-2609-0013", codAmount: 700.5, deliveryCharge: null, codCharge: null },
      ],
    });
  });

  it("reports missing columns and bad rows by row number instead of guessing", () => {
    expect(parseStatementCsv("invoice,charge\nAB-1,60").errors[0]).toMatch(/No COD amount column/);
    expect(parseStatementCsv("cod_amount\n100").errors[0]).toMatch(/No consignment id or order no/);
    const bad = parseStatementCsv("invoice,cod_amount\nAB-1,abc\n,100\nAB-3,200");
    expect(bad.errors).toEqual(['Row 2: COD amount "abc" is not a number', "Row 3: no consignment id or order no."]);
    expect(bad.lines).toHaveLength(1);
  });
});
