// Pure, deliberately NOT "server-only" — lib/packing/queue.ts (server) and
// any future client-side re-check both need the exact same arithmetic. PRD
// §4.8: "SLA colouring — overdue orders turn red," measured from when the
// order entered the queue (createdAt) against the packing_sla_hours setting.

export function hoursSince(date: Date, now: Date = new Date()): number {
  return (now.getTime() - date.getTime()) / (1000 * 60 * 60);
}

export function isOverdue(createdAt: Date, slaHours: number, now: Date = new Date()): boolean {
  return hoursSince(createdAt, now) > slaHours;
}
