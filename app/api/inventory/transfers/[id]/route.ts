import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { can } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/require-permission";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { prisma } from "@/lib/prisma";
import { TRANSFER_VIEW_PERMISSIONS } from "@/lib/transfers/constants";
import { stockDocumentErrorResponse } from "@/lib/transfers/http";
import { cancelTransfer, getTransferView, receiveTransfer, resolveMissing, scanTransferUnit, sendTransfer, setTransferLineQty } from "@/lib/transfers/service";

// C4 — one transfer: read it, or act on it. Every action is checked in
// lib/transfers/service.ts against the transfer's status, the person's
// permission AND their locations (source sends, destination receives).

const side = z.enum(["send", "receive"]);
const id = z.string().trim().min(1).max(50);

const actionSchema = z.discriminatedUnion("action", [
  // What a scanner (or the camera) read, or a SKU typed by hand.
  z.object({ action: z.literal("scan"), side, code: z.string().min(1, "Scan or type a tag").max(60) }),
  z.object({ action: z.literal("setQty"), side, variantId: id, qty: z.number().int("Whole numbers only").min(0).max(10_000) }),
  z.object({ action: z.literal("send") }),
  z.object({ action: z.literal("receive") }),
  z.object({
    action: z.literal("resolve"),
    variantId: id,
    resolution: z.enum(["FOUND", "WRITE_OFF"]),
    qty: z.number().int("Whole numbers only").min(1).max(10_000),
    reason: z.string().trim().min(3, "Say what happened to it").max(500),
  }),
  z.object({ action: z.literal("cancel"), reason: z.string().trim().min(3, "Say why it's cancelled").max(500) }),
]);

async function view(transferId: string, user: Parameters<typeof getTransferView>[1]) {
  const withCost = await can(user, "product.cost.view");
  const transfer = await getTransferView(prisma, user, transferId, { withCost });
  // Belt and braces (CLAUDE.md rule 5): unitCost is only ever added above for cost viewers.
  return transfer ? stripCostFieldsForUser(transfer, user) : null;
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(TRANSFER_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;
  const transfer = await view((await params).id, guard.user);
  if (!transfer) return NextResponse.json({ error: "Transfer not found" }, { status: 404 });
  return NextResponse.json({ transfer });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(TRANSFER_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;
  const { id: transferId } = await params;
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  const input = parsed.data;
  const user = guard.user;

  try {
    let scan: Awaited<ReturnType<typeof scanTransferUnit>> | null = null;
    let result: unknown = null;
    await prisma.$transaction(
      async (tx) => {
        switch (input.action) {
          case "scan":
            scan = await scanTransferUnit(tx, user, transferId, input.side, input.code);
            break;
          case "setQty":
            await setTransferLineQty(tx, user, transferId, input.side, input.variantId, input.qty);
            break;
          case "send":
            await sendTransfer(tx, user, transferId, { request });
            break;
          case "receive":
            result = await receiveTransfer(tx, user, transferId, { request });
            break;
          case "resolve":
            await resolveMissing(tx, user, transferId, { variantId: input.variantId, action: input.resolution, qty: input.qty, reason: input.reason }, { request });
            break;
          case "cancel":
            await cancelTransfer(tx, user, transferId, input.reason, { request });
            break;
        }
      },
      { timeout: 30_000 },
    );
    return NextResponse.json({ scan, result, transfer: await view(transferId, user) });
  } catch (err) {
    const res = stockDocumentErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
