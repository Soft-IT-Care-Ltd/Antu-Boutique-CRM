import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import { toCsv } from "@/lib/import/csv";
import { IMPORT_COLUMNS, IMPORT_EXAMPLES, IMPORT_KINDS } from "@/lib/import/types";

// A ready-to-fill sheet: the columns in order and two example rows.

export async function GET(_request: NextRequest, { params }: { params: Promise<{ kind: string }> }) {
  const kind = z.enum(IMPORT_KINDS).safeParse((await params).kind);
  if (!kind.success) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  const csv = toCsv(IMPORT_COLUMNS[kind.data].map((c) => c.name), IMPORT_EXAMPLES[kind.data]);
  return new NextResponse(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="antu-${kind.data}-template.csv"`, "Cache-Control": "no-store" },
  });
}
