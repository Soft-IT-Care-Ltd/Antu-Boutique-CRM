import { describe, expect, it } from "vitest";

import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import { prisma } from "@/lib/prisma";

// Requires `npm run db:seed` to have run against DATABASE_URL first — reads
// the real seeded customers rather than mocking Prisma, same style as
// lib/catalog/__tests__/catalog-rbac.integration.test.ts.

async function sessionUserFor(phone: string): Promise<SessionUser> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { phone },
    select: { id: true, teamId: true, role: { select: { name: true } } },
  });
  return { id: user.id, role: user.role.name, teamId: user.teamId };
}

describe("customer query scoping (CLAUDE.md rule 6)", () => {
  it("scopes a SALES_EXECUTIVE to only the customers they created", async () => {
    const seUser = await sessionUserFor("01711000004");
    const where = scopedWhere({ deletedAt: null }, seUser);

    const customers = await prisma.customer.findMany({ where });
    expect(customers.length).toBeGreaterThan(0);
    for (const customer of customers) {
      expect(customer.createdById).toBe(seUser.id);
    }

    // Sanity: the seed also has customers created by other roles that must
    // be excluded from this result set.
    const allCustomers = await prisma.customer.findMany({ where: { deletedAt: null } });
    expect(allCustomers.length).toBeGreaterThan(customers.length);
  });

  it("scopes a TEAM_LEADER to their team's customers, including their own", async () => {
    const tlUser = await sessionUserFor("01711000003");
    expect(tlUser.teamId).toBeTruthy();

    const where = scopedWhere({ deletedAt: null }, tlUser);
    const customers = await prisma.customer.findMany({ where });
    expect(customers.length).toBeGreaterThan(0);
    for (const customer of customers) {
      expect(customer.teamId).toBe(tlUser.teamId);
    }
  });

  it("does not restrict ADMIN or MANAGER — they see every customer", async () => {
    const adminUser = await sessionUserFor("01711000001");
    const where = scopedWhere({ deletedAt: null }, adminUser);

    const scoped = await prisma.customer.findMany({ where });
    const all = await prisma.customer.findMany({ where: { deletedAt: null } });
    expect(scoped.length).toBe(all.length);
  });

  it("a client-sent createdById filter can never widen an SE's scope (AND, not override)", async () => {
    const seUser = await sessionUserFor("01711000004");
    const otherUser = await prisma.user.findFirstOrThrow({ where: { id: { not: seUser.id } } });

    // Simulates a route that naively merges a caller-supplied filter in —
    // scopedWhere ANDs the mandatory scope on top regardless of what's passed.
    const where = scopedWhere({ deletedAt: null, createdById: otherUser.id }, seUser);
    const customers = await prisma.customer.findMany({ where });
    expect(customers).toHaveLength(0);
  });
});
