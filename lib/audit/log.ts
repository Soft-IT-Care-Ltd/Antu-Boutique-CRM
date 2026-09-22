import "server-only";

import { prisma } from "@/lib/prisma";

// CLAUDE.md rule 7: every sensitive mutation writes an audit_logs row —
// actor, action, entity, before/after JSON, IP, timestamp. Call this from
// the route handler right after the mutation succeeds (same request, not a
// background job, so a failed write surfaces immediately in dev).

export type AuditLogInput = {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  request?: Request;
};

export function getClientIp(request: Request): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]?.trim() ?? null;
  return request.headers.get("x-real-ip");
}

export async function writeAuditLog(input: AuditLogInput): Promise<void> {
  const ipAddress = input.ipAddress ?? (input.request ? getClientIp(input.request) : null);

  await prisma.auditLog.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before === undefined ? undefined : (input.before as object),
      after: input.after === undefined ? undefined : (input.after as object),
      ipAddress,
    },
  });
}
