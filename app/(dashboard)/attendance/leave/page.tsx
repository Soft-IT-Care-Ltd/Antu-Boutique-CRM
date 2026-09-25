import { AttendanceHeader } from "@/components/attendance/attendance-header";
import { LeaveView } from "@/components/attendance/leave-view";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { attendanceViewLevel } from "@/lib/attendance/http";
import { isOnAttendanceRoster } from "@/lib/attendance/service";
import { listLeaveRequests } from "@/lib/attendance/sheet";
import { prisma } from "@/lib/prisma";
import { dhakaToday } from "@/lib/targets/month";

export const dynamic = "force-dynamic";

// PRD §4.14 — leave requests and their approval. Approvers (leave.approve)
// see the waiting requests in their scope; nobody decides their own.
export default async function LeavePage() {
  const user = await guardPage("/attendance");
  const [level, canMark, canApprove, onRoster] = await Promise.all([attendanceViewLevel(user), can(user, "attendance.mark"), can(user, "leave.approve"), isOnAttendanceRoster(prisma, user.id)]);
  const seesOthers = level === "team" || level === "all";
  const [mine, pending, recent] = await Promise.all([
    onRoster ? listLeaveRequests(prisma, user, "own", { mine: true, take: 30 }) : Promise.resolve([]),
    canApprove && seesOthers ? listLeaveRequests(prisma, user, level!, { status: "PENDING" }) : Promise.resolve([]),
    seesOthers ? listLeaveRequests(prisma, user, level!, { take: 40 }) : Promise.resolve(null),
  ]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <AttendanceHeader title="Leave" description="Ask for leave, and approve your team's." />
      <LeaveView
        meId={user.id}
        canRequest={onRoster && canMark}
        canApprove={canApprove && seesOthers}
        today={dhakaToday()}
        mine={mine}
        pending={pending.filter((l) => l.userId !== user.id)}
        recent={recent ? recent.filter((l) => l.userId !== user.id) : null}
      />
    </div>
  );
}
