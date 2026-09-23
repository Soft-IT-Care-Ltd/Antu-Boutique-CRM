import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/auth/permissions";
import { canViewOrder } from "@/lib/orders/access";
import { readUploadedFile } from "@/lib/uploads/storage";
import type { SessionUser } from "@/lib/auth/types";

// CLAUDE.md: uploads are served through an auth-checked route, never a
// public static path. proxy.ts deliberately excludes "uploads" from its
// matcher (page-redirect-to-login behaviour is wrong for an <img src>
// request) so this route owns its own auth check.
//
// Phase 1.1 gates product photos on "signed in" only — any staff role can
// see one. Order reference images (PRD §4.6 section 3) are narrower:
// "anyone who can view the order can view its images" — so a path under
// orders/<order_no>/... is checked against the same visibility rule
// order.view_own/team/all + scope already enforce for the order itself.

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
};

export async function GET(_request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { path: segments } = await params;
  if (!segments || segments.length === 0 || segments.some((segment) => segment.includes(".."))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const relativePath = segments.join("/");
  const ext = relativePath.split(".").pop()?.toLowerCase() ?? "";
  const contentType = EXT_MIME[ext];
  if (!contentType) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (segments[0] === "orders" && segments[1]) {
    const orderNo = segments[1];
    const order = await prisma.order.findFirst({
      where: { orderNo, deletedAt: null },
      select: { createdById: true, teamId: true },
    });
    if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const sessionUser: SessionUser = { id: session.user.id, role: session.user.role, teamId: session.user.teamId };
    if (!(await canViewOrder(sessionUser, order))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  // P2.3 expense receipts: money data — only whoever can see expenses.
  if (segments[0] === "expenses") {
    const sessionUser: SessionUser = { id: session.user.id, role: session.user.role, teamId: session.user.teamId };
    if (!(await can(sessionUser, "expense.view"))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  try {
    const file = await readUploadedFile(relativePath);
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
