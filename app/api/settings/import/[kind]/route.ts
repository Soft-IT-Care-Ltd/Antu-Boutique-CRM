import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/auth/require-permission";
import type { PermissionKey } from "@/lib/auth/permission-definitions";
import { runImport } from "@/lib/import/run";
import { IMPORT_KINDS, type ImportKind } from "@/lib/import/types";
import { prisma } from "@/lib/prisma";

// P5.2 opening data (Settings → Import): POST a CSV with mode=preview to see
// what would happen, row by row; mode=commit writes it, all or nothing.
// Admin (settings.manage) plus the permission each kind of record needs —
// product import takes unit costs, so it needs product.cost.view too.

const KIND_PERMISSIONS: Record<ImportKind, PermissionKey[]> = {
  products: ["settings.manage", "product.create", "product.cost.view"],
  customers: ["settings.manage", "customer.create"],
  wallets: ["settings.manage", "wallet.manage"],
};

const MAX_BYTES = 5 * 1024 * 1024;
const kindSchema = z.enum(IMPORT_KINDS);
const modeSchema = z.enum(["preview", "commit"]);

export async function POST(request: NextRequest, { params }: { params: Promise<{ kind: string }> }) {
  const kind = kindSchema.safeParse((await params).kind);
  if (!kind.success) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const guard = await requirePermission(KIND_PERMISSIONS[kind.data], "all");
  if (!guard.ok) return guard.response;

  const form = await request.formData().catch(() => null);
  const mode = modeSchema.safeParse(form?.get("mode"));
  const file = form?.get("file");
  if (!mode.success) return NextResponse.json({ error: "mode must be preview or commit" }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose a CSV file" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "The file is over 5 MB — split it into smaller files" }, { status: 400 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  try {
    // fatal: a sheet saved as "CSV" (ANSI) rather than "CSV UTF-8" would turn Bangla into ?s silently.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return NextResponse.json({ error: 'The file isn\'t UTF-8. In Excel use "Save as → CSV UTF-8"; in Google Sheets, "Download → CSV".' }, { status: 400 });
  }

  const report = await runImport(prisma, kind.data, text, guard.user.id, { commit: mode.data === "commit", request });
  return NextResponse.json({ report }, { status: mode.data === "commit" && !report.committed ? 422 : 200 });
}
