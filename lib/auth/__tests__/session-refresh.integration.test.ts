import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadEffectivePermissions } from "@/lib/auth/permissions";
import { buildScopeWhere } from "@/lib/auth/scope";
import { refreshSessionToken } from "@/lib/auth/session-refresh";
import type { SessionUser } from "@/lib/auth/types";
import { inRolledBackTransaction } from "@/lib/test/rollback";

// Every authenticated request re-checks the user (auth.ts jwt callback →
// refreshSessionToken). Runs in a rolled-back transaction against the
// seeded users. Requires `npm run db:seed`.

const asSessionUser = (t: { id?: string; role?: SessionUser["role"]; teamId?: string | null }): SessionUser => ({ id: t.id!, role: t.role!, teamId: t.teamId ?? null });

describe("session re-check against the users table", () => {
  it("a deactivated user is signed out on their next request and holds no permissions", async () => {
    await inRolledBackTransaction(async (tx) => {
      const se = await tx.user.findUniqueOrThrow({ where: { phone: "01711000004" }, include: { role: true } });
      const token = { id: se.id, role: se.role.name, teamId: se.teamId, mustChangePassword: false, name: se.name };

      // Active: the token survives, unchanged.
      expect(await refreshSessionToken(tx, token)).toMatchObject({ id: se.id, role: "SALES_EXECUTIVE" });
      expect((await loadEffectivePermissions(tx, se.id)).has("order.create")).toBe(true);

      await tx.user.update({ where: { id: se.id }, data: { isActive: false } });
      expect(await refreshSessionToken(tx, token)).toBeNull(); // Auth.js drops the session
      expect((await loadEffectivePermissions(tx, se.id)).size).toBe(0);
    });
  }, 60_000);

  it("a token for a user that no longer exists (or has no id) is rejected", async () => {
    await inRolledBackTransaction(async (tx) => {
      expect(await refreshSessionToken(tx, { id: "cmubq40yn008g0asivjy4oh8c", role: "ADMIN", teamId: null })).toBeNull();
      expect(await refreshSessionToken(tx, { role: "ADMIN" })).toBeNull();
    });
  }, 60_000);

  it("a role or team change takes effect on the very next request — including data scope", async () => {
    await inRolledBackTransaction(async (tx) => {
      const se = await tx.user.findUniqueOrThrow({ where: { phone: "01711000004" }, include: { role: true } });
      const token = { id: se.id, role: se.role.name, teamId: se.teamId, mustChangePassword: false };
      expect(buildScopeWhere(asSessionUser(token))).toEqual({ createdById: se.id }); // SE: own records only

      // Promoted to Team Leader of a different team.
      const tlRole = await tx.role.findUniqueOrThrow({ where: { name: "TEAM_LEADER" } });
      const newTeam = await tx.team.create({ data: { name: `Test team ${Date.now()}` } });
      await tx.user.update({ where: { id: se.id }, data: { roleId: tlRole.id, teamId: newTeam.id } });

      const refreshed = await refreshSessionToken(tx, token);
      expect(refreshed).toMatchObject({ role: "TEAM_LEADER", teamId: newTeam.id });
      expect(buildScopeWhere(asSessionUser(refreshed!))).toEqual({ teamId: newTeam.id });
      expect((await loadEffectivePermissions(tx, se.id)).has("order.view_team")).toBe(true);

      // Demoted back: the wider scope is gone immediately, not at next login.
      const seRole = await tx.role.findUniqueOrThrow({ where: { name: "SALES_EXECUTIVE" } });
      await tx.user.update({ where: { id: se.id }, data: { roleId: seRole.id } });
      const demoted = await refreshSessionToken(tx, refreshed!);
      expect(demoted?.role).toBe("SALES_EXECUTIVE");
      expect(buildScopeWhere(asSessionUser(demoted!))).toEqual({ createdById: se.id });

      // A forced password change also applies without re-login.
      await tx.user.update({ where: { id: se.id }, data: { mustChangePassword: true } });
      expect((await refreshSessionToken(tx, demoted!))?.mustChangePassword).toBe(true);
    });
  }, 60_000);

  it("auth.ts wires the re-check into the jwt callback for every non-sign-in call", () => {
    // auth.ts imports next-auth, which can't load under vitest — check its source instead.
    const source = readFileSync(path.resolve(__dirname, "../../../auth.ts"), "utf8");
    expect(source).toMatch(/return refreshSessionToken\(prisma, token\);/);
  });
});
