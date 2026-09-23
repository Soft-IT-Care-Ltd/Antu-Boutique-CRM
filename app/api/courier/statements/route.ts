import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { parseStatementCsv } from "@/lib/courier/payouts/csv";
import { ingestCourierStatement } from "@/lib/courier/reconcile";
import { courierErrorResponse, zodError } from "@/lib/courier/route-errors";
import { dhakaDayStartUtc } from "@/lib/inventory/constants";
import { prisma } from "@/lib/prisma";

// PRD §4.9 "courier statement (manual entry or CSV import) matched against
// orders". Either paste/upload the courier's CSV or type the lines. The
// statement is treated as PAID (it's the record of money received) and
// reconciled immediately; the result says what matched and what didn't.
const money = z.coerce.number().min(0).max(10_000_000);
const lineSchema = z
  .object({
    consignmentId: z.string().trim().max(60).optional().nullable(),
    invoice: z.string().trim().max(60).optional().nullable(),
    codAmount: money,
    deliveryCharge: money.optional().nullable(),
    codCharge: money.optional().nullable(),
  })
  .refine((l) => Boolean(l.consignmentId || l.invoice), "Each line needs a consignment id or an order no.");

const bodySchema = z
  .object({
    courierId: z.string().cuid(),
    reference: z.string().trim().min(2).max(60),
    statementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Statement date must be YYYY-MM-DD"),
    walletId: z.string().trim().min(1).max(50).optional(),
    note: z.string().trim().max(500).optional(),
    grossAmount: money.optional().nullable(),
    deliveryCharge: money.optional().nullable(),
    codCharge: money.optional().nullable(),
    netAmount: money.optional().nullable(),
    csv: z.string().max(500_000).optional(),
    lines: z.array(lineSchema).max(1000).optional(),
  })
  .refine((b) => Boolean(b.csv?.trim()) !== Boolean(b.lines?.length), "Provide either a CSV or typed lines");

export async function POST(request: NextRequest) {
  const guard = await requirePermission("courier.reconcile");
  if (!guard.ok) return guard.response;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return zodError(parsed.error.issues);
  const body = parsed.data;

  let lines = body.lines ?? [];
  if (body.csv) {
    const result = parseStatementCsv(body.csv);
    if (result.errors.length) return NextResponse.json({ error: result.errors.slice(0, 5).join("; ") }, { status: 400 });
    lines = result.lines;
  }
  if (lines.length === 0) return NextResponse.json({ error: "The statement has no lines" }, { status: 400 });

  const courier = await prisma.courierCompany.findUnique({ where: { id: body.courierId }, select: { id: true } });
  if (!courier) return NextResponse.json({ error: "Courier not found" }, { status: 404 });
  const duplicate = await prisma.courierStatement.findUnique({ where: { courierId_reference: { courierId: courier.id, reference: body.reference } }, select: { id: true } });
  if (duplicate) return NextResponse.json({ error: `Statement ${body.reference} was already recorded` }, { status: 409 });

  try {
    const outcome = await prisma.$transaction(
      (tx) =>
        ingestCourierStatement(
          tx,
          {
            courierId: courier.id,
            source: body.csv ? "CSV_IMPORT" : "MANUAL",
            reference: body.reference,
            status: "PAID",
            // Noon in Dhaka on the statement day — the calendar day survives any TZ.
            statementDate: new Date(dhakaDayStartUtc(body.statementDate).getTime() + 12 * 3_600_000),
            grossAmount: body.grossAmount,
            deliveryCharge: body.deliveryCharge,
            codCharge: body.codCharge,
            netAmount: body.netAmount,
            walletId: body.walletId,
            note: body.note,
            lines,
          },
          guard.user.id,
        ),
      { timeout: 60_000 },
    );
    return NextResponse.json({ outcome });
  } catch (error) {
    return courierErrorResponse(error);
  }
}
