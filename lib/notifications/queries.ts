import "server-only";

import { z } from "zod";

import type { Db } from "@/lib/db/tx";

// The bell in the top bar. A person only ever reads or marks their own
// notifications — every query here is keyed on the signed-in user's id,
// never on an id the client sends.

export type NotificationView = { id: string; kind: string; title: string; body: string; href: string | null; readAt: string | null; createdAt: string };

export const markReadSchema = z.union([z.object({ all: z.literal(true) }), z.object({ ids: z.array(z.string().cuid()).min(1).max(100) })]);

export async function listNotifications(db: Db, userId: string, take = 20): Promise<{ items: NotificationView[]; unread: number }> {
  const [rows, unread] = await Promise.all([
    db.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take }),
    db.notification.count({ where: { userId, readAt: null } }),
  ]);
  return {
    unread,
    items: rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, href: n.href, readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString() })),
  };
}

export async function markNotificationsRead(db: Db, userId: string, input: z.infer<typeof markReadSchema>): Promise<number> {
  const where = "all" in input ? { userId, readAt: null } : { userId, readAt: null, id: { in: input.ids } };
  return (await db.notification.updateMany({ where, data: { readAt: new Date() } })).count;
}
