import type { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as null | { user: { id: string; role: string; teamId: string | null } } }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => session.current) }));

import { PATCH as leavePATCH } from "@/app/api/attendance/leave/[id]/route";
import { PUT as recordsPUT } from "@/app/api/attendance/records/route";
import { GET as sheetGET } from "@/app/api/attendance/sheet/route";
import type { SessionUser } from "@/lib/auth/types";
import { AttendanceError, cancelLeave, checkIn, checkOut, correctAttendance, decideLeave, requestLeave } from "@/lib/attendance/service";
import { getAttendanceSheet } from "@/lib/attendance/sheet";
import type { AttendanceSheet } from "@/lib/attendance/types";
import { sessionUserFor, uniquePhone } from "@/lib/courier/__tests__/helpers";
import { prisma } from "@/lib/prisma";
import { inRolledBackTransaction } from "@/lib/test/rollback";

// P4.2 — attendance and leave (PRD §4.14). Writes run in a rolled-back
// transaction; route checks read seeded data and never write.

const SE = "01711000004";
const TL = "01711000003";
const MANAGER = "01711000002";
const PACKING = "01711000005";
const ADMIN = "01711000001";

function asSession(user: SessionUser) {
  session.current = { user: { id: user.id, role: user.role, teamId: user.teamId } };
}
const get = (url: string) => new NextRequest(`http://localhost${url}`);
const json = (url: string, method: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

/** A fresh staff member on the TL's team, so their days are empty. */
async function newcomer(tx: Prisma.TransactionClient, teamId: string | null): Promise<SessionUser> {
  const role = await tx.role.findUniqueOrThrow({ where: { name: "SALES_EXECUTIVE" } });
  const u = await tx.user.create({ data: { name: "New SE", phone: uniquePhone(), passwordHash: "x", roleId: role.id, teamId, joinDate: new Date("2026-01-01T00:00:00Z") } });
  return { id: u.id, role: "SALES_EXECUTIVE", teamId };
}

// Wednesday 23 Sept 2026 in Dhaka (office 10:00–20:00, Friday off).
const at = (hhmm: string, day = "2026-09-23") => new Date(`${day}T${hhmm}:00+06:00`);

beforeEach(() => {
  session.current = null;
});

describe("check-in and check-out", () => {
  it("flags a late arrival, refuses a second check-in, and turns a short day into a half day", async () => {
    await inRolledBackTransaction(async (tx) => {
      const tl = await sessionUserFor(TL);
      const me = await newcomer(tx, tl.teamId);
      const first = await checkIn(tx, me, {}, at("10:40"));
      expect(first).toMatchObject({ status: "LATE", lateMinutes: 40 });
      await expect(checkIn(tx, me, {}, at("10:41"))).rejects.toThrow(/already checked in/);
      const out = await checkOut(tx, me, {}, at("13:00"));
      expect(out.status).toBe("HALF_DAY");
      await expect(checkOut(tx, me, {}, at("13:05"))).rejects.toThrow(/already checked out/);
    });
  });

  it("the owner isn't on the roster", async () => {
    const admin = await sessionUserFor(ADMIN);
    await inRolledBackTransaction(async (tx) => {
      await expect(checkIn(tx, admin, {}, at("10:00"))).rejects.toThrow(AttendanceError);
    });
  });
});

describe("attendance scoping", () => {
  it("Packing sees only their own sheet; a team leader their team; the manager everyone", async () => {
    const [packing, tl, manager] = await Promise.all([PACKING, TL, MANAGER].map(sessionUserFor));
    asSession(packing);
    const own = (await (await sheetGET(get("/api/attendance/sheet"))).json()).sheet as AttendanceSheet;
    expect(own.rows.map((r) => r.userId)).toEqual([packing.id]);
    // Asking for someone else narrows to nothing, never widens.
    const other = (await (await sheetGET(get(`/api/attendance/sheet?userId=${tl.id}`))).json()).sheet as AttendanceSheet;
    expect(other.rows).toEqual([]);

    asSession(tl);
    const team = (await (await sheetGET(get("/api/attendance/sheet"))).json()).sheet as AttendanceSheet;
    expect(team.rows.length).toBeGreaterThan(1);
    expect(team.rows.some((r) => r.userId === packing.id)).toBe(false);

    asSession(manager);
    const all = (await (await sheetGET(get("/api/attendance/sheet"))).json()).sheet as AttendanceSheet;
    expect(all.rows.some((r) => r.userId === packing.id)).toBe(true);
    expect(all.rows.some((r) => r.role === "Admin / Owner")).toBe(false);
  });

  it("only attendance.manage corrects a day; staff can't approve leave", async () => {
    const [se, packing] = await Promise.all([SE, PACKING].map(sessionUserFor));
    asSession(se);
    expect((await recordsPUT(json("/api/attendance/records", "PUT", { userId: se.id, day: "2026-09-01", checkIn: "09:00", checkOut: null, reason: "mine" }))).status).toBe(403);
    const pending = await prisma.leaveRequest.findFirstOrThrow({ where: { userId: packing.id, status: "PENDING" } });
    const res = await leavePATCH(json(`/api/attendance/leave/${pending.id}`, "PATCH", { action: "approve" }), { params: Promise.resolve({ id: pending.id }) });
    expect(res.status).toBe(403);
  });
});

describe("leave", () => {
  it("a team leader approves their member's leave (never their own); it shows on the sheet; overlaps are refused", async () => {
    await inRolledBackTransaction(async (tx) => {
      const [tl, manager, packing] = await Promise.all([TL, MANAGER, PACKING].map(sessionUserFor));
      const me = await newcomer(tx, tl.teamId);
      const now = at("09:00", "2026-09-20");
      const leave = await requestLeave(tx, me, { type: "SICK", fromDay: "2026-09-21", toDay: "2026-09-22", reason: "Fever" }, now);
      await expect(requestLeave(tx, me, { type: "CASUAL", fromDay: "2026-09-22", toDay: "2026-09-24", reason: "Trip" }, now)).rejects.toThrow(/already have leave/);

      // Packing is outside the TL's team: not found, not approvable.
      const theirs = await tx.leaveRequest.findFirstOrThrow({ where: { userId: packing.id, status: "PENDING" } });
      await expect(decideLeave(tx, tl, "team", theirs.id, { approve: true })).rejects.toThrow(/not found/);
      // Nobody decides their own.
      const own = await requestLeave(tx, tl, { type: "CASUAL", fromDay: "2026-12-01", toDay: "2026-12-01", reason: "Errand" });
      await expect(decideLeave(tx, tl, "team", own.id, { approve: true })).rejects.toThrow(/Someone else/);
      // A rejection needs a reason.
      await expect(decideLeave(tx, tl, "team", leave.id, { approve: false })).rejects.toThrow(/why/);

      await decideLeave(tx, tl, "team", leave.id, { approve: true });
      expect(await tx.auditLog.count({ where: { action: "leave.approve", entityId: leave.id } })).toBe(1);
      const sheet = await getAttendanceSheet(tx, manager, "all", "2026-09", { userId: me.id, now: at("21:00", "2026-09-23") });
      const marks = Object.fromEntries(sheet.rows[0].days.map((d) => [d.day, d.mark]));
      expect(marks["2026-09-21"]).toBe("LEAVE");
      expect(marks["2026-09-23"]).toBe("ABSENT");
      expect(sheet.rows[0].totals.leave).toBe(2);

      // Once it has started, the person can't withdraw it themself.
      await expect(cancelLeave(tx, me, { level: "own", canApprove: false }, leave.id, {}, at("12:00", "2026-09-21"))).rejects.toThrow(/already started/);
    });
  });

  it("a correction recomputes the day and is audit-logged with the reason", async () => {
    await inRolledBackTransaction(async (tx) => {
      const [tl, manager] = await Promise.all([TL, MANAGER].map(sessionUserFor));
      const me = await newcomer(tx, tl.teamId);
      const fixed = await correctAttendance(tx, manager, "all", { userId: me.id, day: "2026-09-22", checkIn: "10:05", checkOut: "19:30", reason: "Phone was dead" });
      expect(fixed).toMatchObject({ status: "PRESENT", lateMinutes: 0, correctionReason: "Phone was dead" });
      expect(await tx.auditLog.count({ where: { action: "attendance.correct", entityId: fixed.id } })).toBe(1);
      await expect(correctAttendance(tx, manager, "all", { userId: me.id, day: "2026-09-22", checkIn: "19:00", checkOut: "10:00", reason: "x" })).rejects.toThrow(/after check-in/);
    });
  });
});
