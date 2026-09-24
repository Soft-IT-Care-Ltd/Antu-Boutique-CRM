import { describe, expect, it } from "vitest";

import { deriveStoreCredit, expiredBetween, type CreditRow } from "@/lib/store-credit/balance";

// P3.2 — the balance is derived from the ledger, never stored. These pin the
// derivation: plain sums without expiry, and oldest-expiring-first use when
// credit lapses.

const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));
let seq = 0;
const row = (amount: number, at: number, expiresAt: number | null = null): CreditRow => ({ id: `r${String(++seq).padStart(3, "0")}`, amountPaisa: amount * 100, createdAt: day(at), expiresAt: expiresAt === null ? null : day(expiresAt) });

describe("deriveStoreCredit", () => {
  it("is the plain sum of the ledger when nothing expires", () => {
    const rows = [row(450, 0), row(-200, 1), row(100, 2), row(-50, 3)];
    expect(deriveStoreCredit(rows, day(10)).balancePaisa).toBe(30_000);
  });

  it("ignores rows after the as-of moment", () => {
    const rows = [row(450, 0), row(-200, 5)];
    expect(deriveStoreCredit(rows, day(2)).balancePaisa).toBe(45_000);
  });

  it("lets unspent credit lapse at its expiry", () => {
    const rows = [row(500, 0, 30), row(-200, 10)];
    expect(deriveStoreCredit(rows, day(29)).balancePaisa).toBe(30_000);
    const after = deriveStoreCredit(rows, day(31));
    expect(after.balancePaisa).toBe(0);
    expect(after.expiries).toEqual([{ lotId: rows[0].id, at: day(30), paisa: 30_000 }]);
    expect(expiredBetween(after, day(25), day(35))).toBe(30_000);
    expect(expiredBetween(after, day(31), day(35))).toBe(0);
  });

  it("spends the credit that expires soonest first, never-expiring last", () => {
    // 300 that never expires, then 200 expiring on day 20. Spending 200 on
    // day 5 should use the expiring credit, so nothing is lost on day 20.
    const rows = [row(300, 0), row(200, 1, 20), row(-200, 5)];
    const d = deriveStoreCredit(rows, day(25));
    expect(d.balancePaisa).toBe(30_000);
    expect(d.expiries).toEqual([]);
  });

  it("can't spend credit that had already lapsed", () => {
    const rows = [row(200, 0, 10), row(300, 12), row(-300, 15)];
    const d = deriveStoreCredit(rows, day(20));
    expect(d.balancePaisa).toBe(0);
    expect(d.expiries.map((e) => e.paisa)).toEqual([20_000]);
  });

  it("lists open credit soonest-expiring first", () => {
    const rows = [row(100, 0), row(50, 1, 40), row(70, 2, 20)];
    expect(deriveStoreCredit(rows, day(3)).lots.map((l) => l.remainingPaisa)).toEqual([7_000, 5_000, 10_000]);
  });
});
