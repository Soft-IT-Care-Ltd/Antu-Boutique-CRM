import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { listNotifications } from "@/lib/notifications/queries";
import { prisma } from "@/lib/prisma";

// The top-bar bell: the signed-in person's own notifications, newest first.
// Every staff member has a bell, so this needs a session, not a permission.
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await listNotifications(prisma, session.user.id));
}
