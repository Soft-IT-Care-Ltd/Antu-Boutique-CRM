import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { badRequest } from "@/lib/finance/http";
import { getPosCashWalletId, listDrawers } from "@/lib/pos/drawer";
import { posErrorResponse } from "@/lib/pos/http";
import { prisma } from "@/lib/prisma";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(60).default(15),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission(["pos.drawer", "wallet.view"]);
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error);
  try {
    const walletId = await getPosCashWalletId(prisma);
    return NextResponse.json({ ...(await listDrawers(prisma, walletId, parsed.data.page, parsed.data.pageSize)), ...parsed.data });
  } catch (error) {
    return posErrorResponse(error);
  }
}
