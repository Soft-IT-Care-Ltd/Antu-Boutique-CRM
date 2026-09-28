import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { LIST_KEYS, PAGE_SIZE_OPTIONS } from "@/lib/list/pagination";
import { getListPageSizes, saveListPageSize } from "@/lib/list/prefs";
import { prisma } from "@/lib/prisma";

// The caller's own remembered page sizes (CORRECTIONS.md item 15). Only
// ever the signed-in user's rows — there is no user id to send.

const putSchema = z.object({
  listKey: z.enum(LIST_KEYS),
  pageSize: z.coerce.number().int().refine((n) => (PAGE_SIZE_OPTIONS as readonly number[]).includes(n), "Page size must be 25, 50 or 100"),
});

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ pageSizes: await getListPageSizes(prisma, session.user.id) });
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  await saveListPageSize(prisma, session.user.id, parsed.data.listKey, parsed.data.pageSize);
  return NextResponse.json({ ok: true });
}
