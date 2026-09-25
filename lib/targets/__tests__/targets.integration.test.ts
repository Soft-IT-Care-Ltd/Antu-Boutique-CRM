import type { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as null | { user: { id: string; role: string; teamId: string | null } } }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => session.current) }));

import { GET as leaderboardGET } from "@/app/api/targets/leaderboard/route";
import { GET as targetsGET, PUT as targetsPUT } from "@/app/api/targets/route";
import { POST as evaluatePOST } from "@/app/api/targets/rewards/evaluate/route";
import type { SessionUser } from "@/lib/auth/types";
import { sessionUserFor, uniquePhone } from "@/lib/courier/__tests__/helpers";
import { prisma } from "@/lib/prisma";
import { dhakaMonth, shiftMonth } from "@/lib/targets/month";
import { statsByUser } from "@/lib/targets/performance";
import { evaluateMonth } from "@/lib/targets/rewards";
import { setTarget, TargetError } from "@/lib/targets/service";
import type { Leaderboard, TargetBoard } from "@/lib/targets/types";
import { inRolledBackTransaction } from "@/lib/test/rollback";

// P4.2 — targets, rewards, leaderboard (PRD §4.13). Route checks read the
// seeded demo month (prisma/seed.ts seedTargetsAndAttendanceDemo) and never
// write; writes run in a rolled-back transaction.

const SE = "01711000004";
const TL = "01711000003";
const MANAGER = "01711000002";

function asSession(user: SessionUser) {
  session.current = { user: { id: user.id, role: user.role, teamId: user.teamId } };
}
const get = (url: string) => new NextRequest(`http://localhost${url}`);
const json = (url: string, method: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  session.current = null;
});

describe("target scoping (CLAUDE.md rule 6)", () => {
  it("an executive gets only their own leaderboard row and target — never another executive's numbers", async () => {
    const se = await sessionUserFor(SE);
    asSession(se);
    const lb = (await (await leaderboardGET(get("/api/targets/leaderboard?sort=delivered"))).json()).leaderboard as Leaderboard;
    expect(lb.rows.map((r) => r.userId)).toEqual([se.id]);
    expect(lb.ranked).toBeGreaterThan(1);
    expect(lb.teams).toEqual([]);

    const board = (await (await targetsGET(get("/api/targets"))).json()).board as TargetBoard;
    expect(board.people.map((p) => p.userId)).toEqual([se.id]);
    expect(board.teams).toEqual([]);
    // Nothing cost-shaped anywhere in the payloads.
    expect(JSON.stringify({ lb, board })).not.toMatch(/cost|profit|margin/i);
  });

  it("a team leader sees their team; the manager everyone", async () => {
    const [tl, manager] = await Promise.all([TL, MANAGER].map(sessionUserFor));
    asSession(tl);
    const tlBoard = (await (await leaderboardGET(get("/api/targets/leaderboard"))).json()).leaderboard as Leaderboard;
    const members = await prisma.user.findMany({ where: { teamId: tl.teamId }, select: { id: true } });
    expect(tlBoard.rows.length).toBeGreaterThan(1);
    expect(tlBoard.rows.every((r) => members.some((m) => m.id === r.userId))).toBe(true);

    asSession(manager);
    const all = (await (await leaderboardGET(get("/api/targets/leaderboard"))).json()).leaderboard as Leaderboard;
    expect(all.rows.length).toBe(all.ranked);
  });

  it("only target.manage sets targets or works out rewards", async () => {
    const se = await sessionUserFor(SE);
    asSession(se);
    expect((await targetsPUT(json("/api/targets", "PUT", { month: dhakaMonth(), userId: se.id, orderValue: 1 }))).status).toBe(403);
    expect((await evaluatePOST(json("/api/targets/rewards/evaluate", "POST", { month: shiftMonth(dhakaMonth(), -1) }))).status).toBe(403);
  });
});

describe("what counts as a sale", () => {
  it("leaves out cancelled orders and exchange replacements, and counts returns only for quality", async () => {
    await inRolledBackTransaction(async (tx) => {
      const role = await tx.role.findUniqueOrThrow({ where: { name: "SALES_EXECUTIVE" } });
      const u = await tx.user.create({ data: { name: "Stats SE", phone: uniquePhone(), passwordHash: "x", roleId: role.id } });
      const order = (status: Prisma.OrderCreateInput["status"], total: number, extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) =>
        tx.order.create({ data: { orderNo: `T-${uniquePhone()}`, channel: "WALK_IN", status, total, subtotal: total, createdById: u.id, ...extra } });
      const delivered = await order("DELIVERED", 1000);
      await order("IN_TRANSIT", 500);
      await order("RETURNED", 700);
      await order("CANCELLED", 900);
      await order("DELIVERED", 400, { exchangedFromOrderId: delivered.id });

      const s = (await statsByUser(tx, dhakaMonth(), [u.id])).get(u.id)!;
      expect(s).toMatchObject({ salesPaisa: 150_000, orderCount: 2, deliveredPaisa: 100_000, delivered: 1, returned: 1, inProgress: 1 });
      expect(s.deliveredRate).toBe(0.5);
    });
  });
});

describe("month end", () => {
  it("working out a month saves its awards, audit-logs it, and freezes its targets", async () => {
    await inRolledBackTransaction(async (tx) => {
      const [manager, se] = await Promise.all([MANAGER, SE].map(sessionUserFor));
      const month = "2025-01";
      await setTarget(tx, manager, { month, userId: se.id, orderValue: 1000 });
      expect(await tx.auditLog.count({ where: { action: "target.create", entityType: "target", after: { path: ["month"], equals: month } } })).toBe(1);

      await tx.rewardRule.create({ data: { name: "Any order", scope: "INDIVIDUAL", metric: "ORDER_COUNT", threshold: 1, rewardAmount: 100 } });
      await evaluateMonth(tx, manager, month);
      expect(await tx.rewardEvaluation.count({ where: { month } })).toBe(1);
      expect(await tx.auditLog.count({ where: { action: "reward.evaluate", entityId: month } })).toBe(1);

      await expect(setTarget(tx, manager, { month, userId: se.id, orderValue: 2000 })).rejects.toThrow(TargetError);
      // The month isn't over yet: nothing to work out.
      await expect(evaluateMonth(tx, manager, dhakaMonth())).rejects.toThrow(/once the month is over/);
    });
  });
});
