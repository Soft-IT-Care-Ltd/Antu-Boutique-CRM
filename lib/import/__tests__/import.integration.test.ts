import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { runImport } from "@/lib/import/run";
import { findStockLedgerDivergences } from "@/lib/inventory/ledger";
import { dhakaDayStartUtc, todayInDhaka } from "@/lib/inventory/constants";
import { testProductCode } from "@/lib/test/catalog-codes";
import { checkDeferredConstraintsNow, inRolledBackTransaction } from "@/lib/test/rollback";

// P5.2 opening-data import against the seeded test database, every write
// rolled back. Seed: sizes M/L/XL, colours Maroon (MRN)/Black (BLK),
// category Kurti, the Admin 01711000001 and the demo SE 01711000004.

const TIMEOUT = 120_000;
const ADMIN_PHONE = "01711000001";
const SE_PHONE = "01711000004";

async function admin(tx: Prisma.TransactionClient) {
  return tx.user.findUniqueOrThrow({ where: { phone: ADMIN_PHONE }, select: { id: true } });
}

/** A phone no seeded or earlier-test customer has. */
function freshPhone(n: number): string {
  return `0133${String(Date.now() % 1_000_000).padStart(6, "0")}${n}`.slice(0, 11);
}

describe("product import", () => {
  it(
    "previews without writing, then commits products, variants and opening stock through the ledger",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { id: actorId } = await admin(tx);
        const code = testProductCode();
        const csv = [
          "product_code,product_name,category,base_price,tags,size,colour,price_override,opening_qty,unit_cost,low_stock_threshold",
          `${code},Import Kurti,kurti,1850,eid; new,M,maroon,,6,950,`,
          `${code},Import Kurti,,,,L,MRN,1950,4,"1,000",2`,
          `${code},Import Kurti,,,,XL,Black,,,,`,
        ].join("\n");

        const preview = await runImport(tx, "products", csv, actorId, { commit: false });
        expect(preview.errors).toEqual([]);
        expect(preview.committed).toBe(false);
        expect(Object.fromEntries(preview.summary.map((s) => [s.label, s.value]))).toMatchObject({ "New products": "1", "New variants": "3", "Opening stock": "10 units" });
        expect(await tx.product.count({ where: { code } })).toBe(0);

        // Counted before and after, not "in the last minute": a freshly seeded
        // test database holds the seed's own stock-shortage expenses from moments ago.
        const shortagesBefore = await tx.expense.count({ where: { category: { kind: "STOCK_SHORTAGE" } } });
        const result = await runImport(tx, "products", csv, actorId, { commit: true });
        expect(result.committed).toBe(true);

        const product = await tx.product.findUniqueOrThrow({ where: { code }, include: { variants: { include: { size: true, color: true, stockMovements: true } }, category: true } });
        expect(product.category?.name).toBe("Kurti");
        expect(product.basePrice.toString()).toBe("1850");
        expect(product.tags).toEqual(["eid", "new"]);
        const bySize = Object.fromEntries(product.variants.map((v) => [v.size.name, v]));
        expect(bySize.M.sku).toBe(`${code}MMRN`);
        expect(bySize.M.stockQty).toBe(6);
        expect(bySize.M.weightedAvgCost.toString()).toBe("950");
        expect(bySize.L.priceOverride?.toString()).toBe("1950");
        expect(bySize.L.weightedAvgCost.toString()).toBe("1000");
        expect(bySize.L.lowStockThreshold).toBe(2);
        expect(bySize.XL.stockQty).toBe(0);
        expect(bySize.XL.stockMovements).toHaveLength(0);

        // Opening stock is one OPENING_BALANCE ledger row per variant (CLAUDE.md rule 2).
        expect(bySize.M.stockMovements).toMatchObject([{ type: "ADJUSTMENT", referenceType: "OPENING_BALANCE", qty: 6, stockAfter: 6 }]);
        expect(bySize.M.stockMovements[0].unitCostSnapshot.toString()).toBe("950");
        await checkDeferredConstraintsNow(tx);
        expect(await findStockLedgerDivergences(tx)).toEqual([]);

        // No expense for an opening balance (PRD §4.12), one audit row for the product.
        expect(await tx.expense.count({ where: { category: { kind: "STOCK_SHORTAGE" } } })).toBe(shortagesBefore);
        expect(await tx.auditLog.count({ where: { entityId: product.id, action: "import.product_create" } })).toBe(1);

        // Importing again: the variants now have history, so no second opening balance.
        const again = await runImport(tx, "products", csv, actorId, { commit: true });
        expect(again.committed).toBe(false);
        expect(again.errors.map((e) => e.line)).toEqual([2, 3]);
        expect(again.errors[0].message).toMatch(/already has stock history/);
      });
    },
    TIMEOUT,
  );

  it(
    "reports every bad row and writes nothing",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { id: actorId } = await admin(tx);
        const code = testProductCode();
        const csv = [
          "product_code,product_name,category,base_price,size,colour,opening_qty,unit_cost",
          `${code},Bad Sheet,Kurti,1200,M,Purple Haze,1,500`,
          `${code},Bad Sheet,Kurti,1300,L,Maroon,2,500`,
          `${code},Bad Sheet,Kurti,,M,Maroon,3,`,
          `${code},Bad Sheet,Kurti,,M,Maroon,,`,
          `,No Price,Kurti,,M,Maroon,,`,
        ].join("\n");
        const report = await runImport(tx, "products", csv, actorId, { commit: true });
        expect(report.committed).toBe(false);
        const messages = report.errors.map((e) => `${e.line}: ${e.message}`);
        expect(messages).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^2: colour "Purple Haze" isn't in Settings/),
            expect.stringMatching(/^3: base_price "1300" differs/),
            expect.stringMatching(/^4: unit_cost is required/),
            expect.stringMatching(/^5: M \/ Maroon appears twice/),
            expect.stringMatching(/^6: base_price is required/),
          ]),
        );
        expect(await tx.product.count({ where: { code } })).toBe(0);
      });
    },
    TIMEOUT,
  );
});

describe("customer import", () => {
  it(
    "creates new people owned by owner_phone, skips phones already known, and refuses bad rows",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { id: actorId } = await admin(tx);
        const se = await tx.user.findUniqueOrThrow({ where: { phone: SE_PHONE }, select: { id: true, teamId: true } });
        const existing = await tx.customer.findFirstOrThrow({ where: { deletedAt: null }, select: { phone: true } });
        const a = freshPhone(1);
        const b = freshPhone(2);
        const csv = [
          "Customer Name,Mobile,Alt Phone,Division,District,Address,Tags,Owner Phone",
          `ফারজানা আক্তার,+88${a},,dhaka,Dhaka,"House 12, Road 5",VIP; wholesale,${SE_PHONE}`,
          `Rezaul Karim,${b},,Chittagong,,,,`,
          `Already Here,${existing.phone},,,,,,`,
        ].join("\n");

        const report = await runImport(tx, "customers", csv, actorId, { commit: true });
        expect(report.errors).toEqual([]);
        expect(report.committed).toBe(true);
        expect(report.warnings).toHaveLength(1);

        const first = await tx.customer.findUniqueOrThrow({ where: { phone: a } });
        expect(first).toMatchObject({ name: "ফারজানা আক্তার", division: "Dhaka", addressDetail: "House 12, Road 5", createdById: se.id, teamId: se.teamId });
        expect(first.tags.sort()).toEqual(["VIP", "WHOLESALE"]);
        const second = await tx.customer.findUniqueOrThrow({ where: { phone: b } });
        expect(second).toMatchObject({ division: "Chattogram", createdById: actorId });

        const bad = await runImport(tx, "customers", ["name,phone,tags,owner_phone", `X,${freshPhone(3)},Gold,`, `Y,12345,,`, `Z,${freshPhone(4)},,01799999999`].join("\n"), actorId, { commit: true });
        expect(bad.committed).toBe(false);
        expect(bad.errors.map((e) => e.line)).toEqual([2, 3, 4]);
      });
    },
    TIMEOUT,
  );
});

describe("wallet import", () => {
  it(
    "updates an existing wallet's opening balance and adds a new one, audited",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const { id: actorId } = await admin(tx);
        const wallet = await tx.wallet.findFirstOrThrow({ where: { type: "CASH" } });
        const csv = ["wallet_name,type,opening_balance,opening_date", `${wallet.name.toUpperCase()},cash,"12,500",01/09/2026`, `Test Import Rocket,Rocket,0,2026-09-01`].join("\n");
        const report = await runImport(tx, "wallets", csv, actorId, { commit: true });
        expect(report.errors).toEqual([]);
        expect(report.committed).toBe(true);

        const updated = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
        expect(updated.openingBalance.toString()).toBe("12500");
        expect(updated.openingDate.toISOString()).toBe(dhakaDayStartUtc("2026-09-01").toISOString());
        expect(await tx.wallet.count({ where: { name: "Test Import Rocket", type: "ROCKET" } })).toBe(1);
        expect(await tx.auditLog.count({ where: { entityId: wallet.id, action: "wallet.update" } })).toBeGreaterThan(0);

        const future = await runImport(tx, "wallets", ["wallet_name,type,opening_balance,opening_date", `X Wallet,Bank,5,${todayInDhaka().slice(0, 4)}-12-31`].join("\n"), actorId, { commit: false });
        if (todayInDhaka() < `${todayInDhaka().slice(0, 4)}-12-31`) expect(future.errors[0].message).toMatch(/future/);
      });
    },
    TIMEOUT,
  );
});
