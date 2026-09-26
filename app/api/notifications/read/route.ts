import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/auth";
import { markNotificationsRead, markReadSchema } from "@/lib/notifications/queries";
import { prisma } from "@/lib/prisma";

// Marks some ({ ids }) or all ({ all: true }) of the caller's own
// notifications read. Someone else's ids simply match nothing.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = markReadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Send { ids: [...] } or { all: true }" }, { status: 400 });
  return NextResponse.json({ ok: true, marked: await markNotificationsRead(prisma, session.user.id, parsed.data) });
}
