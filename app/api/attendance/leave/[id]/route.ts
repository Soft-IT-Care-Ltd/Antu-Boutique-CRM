import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getClientIp } from "@/lib/audit/log";
import { can } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/require-permission";
import { attendanceErrorResponse, attendanceViewLevel } from "@/lib/attendance/http";
import { cancelLeave, decideLeave } from "@/lib/attendance/service";
import { prisma } from "@/lib/prisma";
import { badRequest } from "@/lib/targets/http";

// Approve / reject (leave.approve — a TL for their team, Manager/Admin for
// anyone, never one's own), or cancel (the person, or an approver).
const schema = z.object({
  action: z.enum(["approve", "reject", "cancel"]),
  note: z.string().trim().max(300).nullable().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["attendance.mark", "leave.approve"]);
  if (!guard.ok) return guard.response;
  const id = z.string().cuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "Leave request not found" }, { status: 404 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error);

  const [level, canApprove] = await Promise.all([attendanceViewLevel(guard.user), can(guard.user, "leave.approve")]);
  const ctx = { request, ip: getClientIp(request) };
  try {
    if (parsed.data.action === "cancel") {
      await cancelLeave(prisma, guard.user, { level, canApprove }, id.data, ctx);
    } else {
      if (!canApprove || !level) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      await decideLeave(prisma, guard.user, level, id.data, { approve: parsed.data.action === "approve", note: parsed.data.note }, ctx);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return attendanceErrorResponse(error);
  }
}
