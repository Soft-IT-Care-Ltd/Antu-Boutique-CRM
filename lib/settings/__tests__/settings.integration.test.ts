import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { countAdministrators, loadEffectivePermissions } from "@/lib/auth/permissions";
import { getLowStockAlerts } from "@/lib/inventory/stock-report";
import { LOW_STOCK_DEFAULT_SQL } from "@/lib/catalog/low-stock-threshold";
import { LOW_STOCK_DEFAULT_SETTING_KEY } from "@/lib/catalog/constants";
import { PAYMENT_METHODS_SETTING_KEY } from "@/lib/payments/method-settings";
import { assertPaymentMethodEnabled } from "@/lib/payments/methods";
import { createUser, createUserSchema, resetPassword, setRolePermissions, setUserOverrides, StaffError, updateTeam, updateUser } from "@/lib/settings/staff";
import { inRolledBackTransaction } from "@/lib/test/rollback";
import { WalletError } from "@/lib/wallets/service";

// P5.2 Settings: the people/permission guards and the settings that change
// behaviour elsewhere. Seeded logins: Admin 01711000001, Manager
// 01711000002, Team Leader 01711000003, SE 01711000004. All rolled back.

const TIMEOUT = 120_000;
const byPhone = (tx: Prisma.TransactionClient, phone: string) => tx.user.findUniqueOrThrow({ where: { phone }, include: { role: true } });
const roleId = async (tx: Prisma.TransactionClient, name: "ADMIN" | "MANAGER" | "SALES_EXECUTIVE") => (await tx.role.findUniqueOrThrow({ where: { name } })).id;

describe("staff: no escalation, no lock-out", () => {
  it(
    "a Manager (user.edit, no permission.manage) can't reset the owner's password or make anyone an Admin",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [admin, manager, se] = await Promise.all([byPhone(tx, "01711000001"), byPhone(tx, "01711000002"), byPhone(tx, "01711000004")]);
        await expect(resetPassword(tx, manager.id, admin.id, "NewPass1234")).rejects.toMatchObject({ status: 403 });
        await expect(updateUser(tx, manager.id, se.id, { roleId: await roleId(tx, "ADMIN") })).rejects.toThrow(/permissions you don't hold/);
        await expect(
          createUser(tx, manager.id, { name: "Sneaky", phone: "01799000111", roleId: await roleId(tx, "ADMIN"), joinDate: "2026-09-01", password: "Password123" }),
        ).rejects.toBeInstanceOf(StaffError);
        // …but can do their job: add a Sales Executive and reset their password.
        // The route parses first (createUserSchema): the phone and email are normalised there.
        const input = createUserSchema.parse({ name: "New SE", phone: "+8801799000112", email: "New.SE@Example.com", roleId: await roleId(tx, "SALES_EXECUTIVE"), teamId: se.teamId, joinDate: "2026-09-01", password: "Password123" });
        const hire = await createUser(tx, manager.id, input);
        expect(hire).toMatchObject({ phone: "01799000112", email: "new.se@example.com", mustChangePassword: true, teamId: se.teamId });
        await resetPassword(tx, manager.id, hire.id, "Another1234");
        expect(await tx.auditLog.count({ where: { entityId: hire.id, action: { in: ["user.create", "user.password_reset"] } } })).toBe(2);
        // Deactivating needs user.delete, which the Manager's template lacks.
        await expect(updateUser(tx, manager.id, hire.id, { isActive: false })).rejects.toMatchObject({ status: 403 });
      });
    },
    TIMEOUT,
  );

  // Each refusal gets its own rolled-back transaction: in the app every call
  // is its own transaction, so a refused change rolls back its partial writes;
  // inside one shared test transaction they would linger.
  it(
    "refuses any change that leaves nobody able to run Settings, and self-deactivation",
    async () => {
      const attempts: ((tx: Prisma.TransactionClient, adminId: string) => Promise<unknown>)[] = [
        (tx, id) => updateUser(tx, id, id, { isActive: false }),
        async (tx, id) => updateUser(tx, id, id, { roleId: await roleId(tx, "MANAGER") }),
        (tx, id) => setUserOverrides(tx, id, id, [{ key: "permission.manage", effect: "REVOKE", reason: "test" }]),
        async (tx, id) => {
          const adminRole = await tx.role.findUniqueOrThrow({ where: { name: "ADMIN" }, include: { permissions: { include: { permission: true } } } });
          return setRolePermissions(tx, id, adminRole.id, adminRole.permissions.map((p) => p.permission.key).filter((k) => k !== "settings.manage") as Parameters<typeof setRolePermissions>[3]);
        },
      ];
      const messages: string[] = [];
      for (const attempt of attempts) {
        await inRolledBackTransaction(async (tx) => {
          const admin = await byPhone(tx, "01711000001");
          // The seeded database has exactly one active administrator.
          expect(await countAdministrators(tx)).toBe(1);
          const error = await attempt(tx, admin.id).then(() => null, (e: unknown) => e);
          expect(error).toBeInstanceOf(StaffError);
          messages.push((error as Error).message);
        });
      }
      expect(messages[0]).toMatch(/your own account/);
      for (const m of messages.slice(1)) expect(m).toMatch(/nobody who can change settings/);
    },
    TIMEOUT,
  );

  it(
    "with a second administrator by override, the first can step down",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [admin, manager] = await Promise.all([byPhone(tx, "01711000001"), byPhone(tx, "01711000002")]);
        await setUserOverrides(tx, admin.id, manager.id, [
          { key: "settings.manage", effect: "GRANT", reason: "deputy" },
          { key: "permission.manage", effect: "GRANT", reason: "deputy" },
        ]);
        expect(await countAdministrators(tx)).toBe(2);
        const adminRole = await tx.role.findUniqueOrThrow({ where: { name: "ADMIN" }, include: { permissions: { include: { permission: true } } } });
        const withoutSettings = adminRole.permissions.map((p) => p.permission.key).filter((k) => k !== "settings.manage") as Parameters<typeof setRolePermissions>[3];
        await setRolePermissions(tx, admin.id, adminRole.id, withoutSettings);
        expect((await loadEffectivePermissions(tx, admin.id)).has("settings.manage")).toBe(false);
        expect(await tx.auditLog.count({ where: { entityId: adminRole.id, action: "role.permissions_update" } })).toBe(1);
        expect(await tx.auditLog.count({ where: { entityId: manager.id, action: "user.permission_overrides" } })).toBe(1);
      });
    },
    TIMEOUT,
  );

  it(
    "a role edit reaches everyone in the role on the next permission read",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [admin, se] = await Promise.all([byPhone(tx, "01711000001"), byPhone(tx, "01711000004")]);
        const before = await loadEffectivePermissions(tx, se.id);
        expect(before.has("lead.delete")).toBe(false);
        await setRolePermissions(tx, admin.id, se.roleId, [...before, "lead.delete"]);
        expect((await loadEffectivePermissions(tx, se.id)).has("lead.delete")).toBe(true);
      });
    },
    TIMEOUT,
  );

  it(
    "making someone team leader moves them into the team; a team with members can't be switched off",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const [admin, se] = await Promise.all([byPhone(tx, "01711000001"), byPhone(tx, "01711000004")]);
        const team = await tx.team.create({ data: { name: "Test team" } });
        await updateTeam(tx, admin.id, team.id, { leaderId: se.id });
        expect((await tx.user.findUniqueOrThrow({ where: { id: se.id } })).teamId).toBe(team.id);
        await expect(updateTeam(tx, admin.id, team.id, { isActive: false })).rejects.toThrow(/still has 1 active member/);
      });
    },
    TIMEOUT,
  );
});

describe("payment methods switched off", () => {
  it(
    "refuses new money by a switched-off method; system methods are never switched",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        await expect(assertPaymentMethodEnabled(tx, "ROCKET")).resolves.toBeUndefined();
        await tx.setting.upsert({ where: { key: PAYMENT_METHODS_SETTING_KEY }, update: { value: '["CASH","BKASH"]' }, create: { key: PAYMENT_METHODS_SETTING_KEY, value: '["CASH","BKASH"]' } });
        await expect(assertPaymentMethodEnabled(tx, "ROCKET")).rejects.toBeInstanceOf(WalletError);
        await expect(assertPaymentMethodEnabled(tx, "CASH")).resolves.toBeUndefined();
        await expect(assertPaymentMethodEnabled(tx, "STORE_CREDIT")).resolves.toBeUndefined();
      });
    },
    TIMEOUT,
  );
});

describe("low-stock default from Settings", () => {
  it(
    "is what a variant without its own threshold is measured against",
    async () => {
      await inRolledBackTransaction(async (tx) => {
        const read = async () => (await tx.$queryRaw<{ t: number }[]>`SELECT ${LOW_STOCK_DEFAULT_SQL} AS t`)[0].t;
        await tx.setting.deleteMany({ where: { key: LOW_STOCK_DEFAULT_SETTING_KEY } });
        expect(await read()).toBe(5);
        await tx.setting.create({ data: { key: LOW_STOCK_DEFAULT_SETTING_KEY, value: "12" } });
        expect(await read()).toBe(12);
        // getLowStockAlerts runs on the prisma singleton, outside this transaction — just prove it still runs.
        await expect(getLowStockAlerts()).resolves.toBeInstanceOf(Array);
      });
    },
    TIMEOUT,
  );
});
