import "server-only";

import { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { attendanceRosterWhere } from "@/lib/auth/rosters";
import { levelScopeWhere, type ViewLevel } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import { LEAVE_AHEAD_DAYS, LEAVE_BACKDATE_DAYS, MAX_LEAVE_DAYS, type LeaveTypeValue } from "@/lib/attendance/constants";
import { attendanceStatus } from "@/lib/attendance/rules";
import { getOfficeHours } from "@/lib/attendance/settings";
import { withTx, type Db } from "@/lib/db/tx";
import { dhakaDayOf, dhakaDayStart, dhakaToday } from "@/lib/targets/month";

// PRD §4.14 — check-in / check-out, a manager's corrections, and leave.
//
// Times always come from the server clock, never the phone. Each day's
// status is worked out from the office-hour settings when it's recorded and
// kept (lib/attendance/rules.ts). Corrections and every leave decision are
// audit-logged (CLAUDE.md rule 7).

export class AttendanceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type RequestContext = { request?: Request; ip?: string | null };

/** Whether attendance is kept for this user (everyone active but the owner). */
export async function isOnAttendanceRoster(db: Db, userId: string): Promise<boolean> {
  return (await db.user.count({ where: { AND: [{ id: userId }, attendanceRosterWhere] } })) > 0;
}

async function assertOnRoster(db: Db, userId: string) {
  const ok = await isOnAttendanceRoster(db, userId);
  if (!ok) throw new AttendanceError("Attendance isn't kept for this account.", 403);
}

export async function checkIn(db: Db, user: SessionUser, ctx: RequestContext = {}, now = new Date()) {
  await assertOnRoster(db, user.id);
  const day = dhakaToday(now);
  const hours = await getOfficeHours(db);
  const { status, lateMinutes } = attendanceStatus({ day, checkInAt: now, checkOutAt: null }, hours);
  const workDate = dhakaDayStart(day);
  const already = new AttendanceError("You've already checked in today.", 409);
  if (await db.attendance.count({ where: { userId: user.id, workDate } })) throw already;
  try {
    return await db.attendance.create({ data: { userId: user.id, workDate, checkInAt: now, status, lateMinutes, checkInIp: ctx.ip ?? null } });
  } catch (error) {
    // Two taps at once: the unique (userId, workDate) index lets only one in.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw already;
    throw error;
  }
}

export async function checkOut(db: Db, user: SessionUser, ctx: RequestContext = {}, now = new Date()) {
  const day = dhakaToday(now);
  const hours = await getOfficeHours(db);
  return withTx(db, async (tx) => {
    const row = await tx.attendance.findUnique({ where: { userId_workDate: { userId: user.id, workDate: dhakaDayStart(day) } } });
    if (!row) throw new AttendanceError("Check in first — there's no check-in for today.", 409);
    if (row.checkOutAt) throw new AttendanceError("You've already checked out today.", 409);
    const { status, lateMinutes } = attendanceStatus({ day, checkInAt: row.checkInAt, checkOutAt: now }, hours);
    // Conditional on still being open, so two taps can't both check out.
    const updated = await tx.attendance.updateMany({ where: { id: row.id, checkOutAt: null }, data: { checkOutAt: now, status, lateMinutes, checkOutIp: ctx.ip ?? null } });
    if (updated.count === 0) throw new AttendanceError("You've already checked out today.", 409);
    return tx.attendance.findUniqueOrThrow({ where: { id: row.id } });
  });
}

export async function todayRecord(db: Db, userId: string, now = new Date()) {
  return db.attendance.findUnique({ where: { userId_workDate: { userId, workDate: dhakaDayStart(dhakaToday(now)) } } });
}

/** A roster member this user's view level reaches, or a 404. */
async function staffInScope(db: Db, user: SessionUser, level: ViewLevel, userId: string) {
  const person = await db.user.findFirst({
    where: { AND: [{ id: userId }, attendanceRosterWhere, levelScopeWhere(user, level, { ownerField: "id" }) as Prisma.UserWhereInput] },
    select: { id: true, name: true, teamId: true, joinDate: true },
  });
  if (!person) throw new AttendanceError("Staff member not found.", 404);
  return person;
}

export type CorrectionInput = {
  userId: string;
  day: string;
  /** Dhaka "HH:mm". */
  checkIn: string;
  checkOut: string | null;
  reason: string;
};

const clockOn = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+06:00`);

const attendanceAudit = (a: { workDate: Date; checkInAt: Date; checkOutAt: Date | null; status: string; lateMinutes: number }) => ({
  day: dhakaDayOf(a.workDate),
  checkInAt: a.checkInAt.toISOString(),
  checkOutAt: a.checkOutAt?.toISOString() ?? null,
  status: a.status,
  lateMinutes: a.lateMinutes,
});

/**
 * attendance.manage: sets a day's times for someone — a forgotten check-out,
 * a check-in from a dead phone. Creates the day if there was none. The
 * status is worked out again from today's office-hour settings.
 */
export async function correctAttendance(db: Db, actor: SessionUser, level: ViewLevel, input: CorrectionInput, ctx: RequestContext = {}, now = new Date()) {
  const person = await staffInScope(db, actor, level, input.userId);
  if (input.day > dhakaToday(now)) throw new AttendanceError("That day hasn't happened yet.");
  const checkInAt = clockOn(input.day, input.checkIn);
  const checkOutAt = input.checkOut ? clockOn(input.day, input.checkOut) : null;
  if (checkOutAt && checkOutAt <= checkInAt) throw new AttendanceError("Check-out must be after check-in.");
  if (checkInAt > now || (checkOutAt && checkOutAt > now)) throw new AttendanceError("Those times are still in the future.");
  const reason = input.reason.trim();
  if (!reason) throw new AttendanceError("Say why the day is being corrected.");

  const hours = await getOfficeHours(db);
  const { status, lateMinutes } = attendanceStatus({ day: input.day, checkInAt, checkOutAt }, hours);
  const workDate = dhakaDayStart(input.day);
  const data = { checkInAt, checkOutAt, status, lateMinutes, correctedById: actor.id, correctedAt: now, correctionReason: reason };

  return withTx(db, async (tx) => {
    const before = await tx.attendance.findUnique({ where: { userId_workDate: { userId: person.id, workDate } } });
    const saved = before ? await tx.attendance.update({ where: { id: before.id }, data }) : await tx.attendance.create({ data: { userId: person.id, workDate, ...data } });
    await writeAuditLogWith(tx, {
      actorId: actor.id,
      action: "attendance.correct",
      entityType: "attendance",
      entityId: saved.id,
      before: before ? attendanceAudit(before) : undefined,
      after: { ...attendanceAudit(saved), userId: person.id, reason },
      request: ctx.request,
      ipAddress: ctx.ip,
    });
    return saved;
  });
}

// ─── Leave ───────────────────────────────────────────────────────────────

export type LeaveInput = { type: LeaveTypeValue; fromDay: string; toDay: string; reason: string };

const dayDiff = (a: string, b: string) => Math.round((dhakaDayStart(b).getTime() - dhakaDayStart(a).getTime()) / 86_400_000);

const OPEN_LEAVE = ["PENDING", "APPROVED"] as const;

/** attendance.mark: asks for leave for oneself. */
export async function requestLeave(db: Db, user: SessionUser, input: LeaveInput, now = new Date()) {
  await assertOnRoster(db, user.id);
  const today = dhakaToday(now);
  if (input.toDay < input.fromDay) throw new AttendanceError("The last day is before the first day.");
  if (dayDiff(input.fromDay, today) > LEAVE_BACKDATE_DAYS) throw new AttendanceError(`Leave can be asked for up to ${LEAVE_BACKDATE_DAYS} days back.`);
  if (dayDiff(today, input.toDay) > LEAVE_AHEAD_DAYS) throw new AttendanceError("Leave can be asked for up to a year ahead.");
  if (dayDiff(input.fromDay, input.toDay) + 1 > MAX_LEAVE_DAYS) throw new AttendanceError(`One request covers at most ${MAX_LEAVE_DAYS} days.`);
  const reason = input.reason.trim();
  if (!reason) throw new AttendanceError("Give a reason for the leave.");

  const fromDate = dhakaDayStart(input.fromDay);
  const toDate = dhakaDayStart(input.toDay);
  return withTx(db, async (tx) => {
    // One writer per person at a time, so two requests can't both pass the overlap check.
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${user.id} FOR UPDATE`;
    const overlap = await tx.leaveRequest.findFirst({ where: { userId: user.id, status: { in: [...OPEN_LEAVE] }, fromDate: { lte: toDate }, toDate: { gte: fromDate } } });
    if (overlap) throw new AttendanceError("You already have leave asked for or approved on some of those days.", 409);
    return tx.leaveRequest.create({ data: { userId: user.id, type: input.type, fromDate, toDate, reason } });
  });
}

type LeaveRow = Prisma.LeaveRequestGetPayload<object>;

const leaveAudit = (l: LeaveRow) => ({
  userId: l.userId,
  type: l.type,
  from: dhakaDayOf(l.fromDate),
  to: dhakaDayOf(l.toDate),
  status: l.status,
  decisionNote: l.decisionNote,
});

/**
 * leave.approve: a Team Leader decides their team's requests, a
 * Manager/Admin anyone's — never their own. A rejection says why.
 */
export async function decideLeave(db: Db, actor: SessionUser, level: ViewLevel, id: string, decision: { approve: boolean; note?: string | null }, ctx: RequestContext = {}) {
  const note = decision.note?.trim() || null;
  if (!decision.approve && !note) throw new AttendanceError("Say why the leave is rejected.");
  return withTx(db, async (tx) => {
    const request = await tx.leaveRequest.findUnique({ where: { id } });
    if (!request) throw new AttendanceError("Leave request not found.", 404);
    await staffInScope(tx, actor, level, request.userId).catch(() => {
      throw new AttendanceError("Leave request not found.", 404);
    });
    if (request.userId === actor.id) throw new AttendanceError("Someone else has to decide your own leave.", 403);
    if (request.status !== "PENDING") throw new AttendanceError("This request has already been decided.", 409);
    const updated = await tx.leaveRequest.updateMany({
      where: { id, status: "PENDING" },
      data: { status: decision.approve ? "APPROVED" : "REJECTED", decidedById: actor.id, decidedAt: new Date(), decisionNote: note },
    });
    if (updated.count === 0) throw new AttendanceError("This request has already been decided.", 409);
    const after = await tx.leaveRequest.findUniqueOrThrow({ where: { id } });
    await writeAuditLogWith(tx, {
      actorId: actor.id,
      action: decision.approve ? "leave.approve" : "leave.reject",
      entityType: "leave_request",
      entityId: id,
      before: leaveAudit(request),
      after: leaveAudit(after),
      request: ctx.request,
      ipAddress: ctx.ip,
    });
    return after;
  });
}

/**
 * Withdraws leave. The person themself: while it waits, or before an
 * approved leave has started. An approver (in scope): an approved leave
 * any time — the sheet then shows those days as they really were.
 */
export async function cancelLeave(db: Db, actor: SessionUser, opts: { level: ViewLevel | null; canApprove: boolean }, id: string, ctx: RequestContext = {}, now = new Date()) {
  return withTx(db, async (tx) => {
    const request = await tx.leaveRequest.findUnique({ where: { id } });
    if (!request) throw new AttendanceError("Leave request not found.", 404);
    const own = request.userId === actor.id;
    if (!own) {
      if (!opts.canApprove || !opts.level) throw new AttendanceError("Leave request not found.", 404);
      await staffInScope(tx, actor, opts.level, request.userId).catch(() => {
        throw new AttendanceError("Leave request not found.", 404);
      });
    }
    if (request.status !== "PENDING" && request.status !== "APPROVED") throw new AttendanceError("Only waiting or approved leave can be cancelled.", 409);
    if (own && request.status === "APPROVED" && dhakaDayOf(request.fromDate) <= dhakaToday(now)) {
      throw new AttendanceError("This leave has already started — ask your team leader to change it.", 409);
    }
    const updated = await tx.leaveRequest.updateMany({ where: { id, status: request.status }, data: { status: "CANCELLED", cancelledById: actor.id, cancelledAt: now } });
    if (updated.count === 0) throw new AttendanceError("This request just changed — refresh and try again.", 409);
    const after = await tx.leaveRequest.findUniqueOrThrow({ where: { id } });
    await writeAuditLogWith(tx, {
      actorId: actor.id,
      action: "leave.cancel",
      entityType: "leave_request",
      entityId: id,
      before: leaveAudit(request),
      after: leaveAudit(after),
      request: ctx.request,
      ipAddress: ctx.ip,
    });
    return after;
  });
}
