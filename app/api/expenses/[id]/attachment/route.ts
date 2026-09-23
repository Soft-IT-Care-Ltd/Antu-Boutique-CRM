import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { EXPENSE_ATTACHMENT_MIME_TYPES } from "@/lib/expenses/constants";
import { setExpenseAttachment } from "@/lib/expenses/service";
import { financeErrorResponse } from "@/lib/finance/http";
import { prisma } from "@/lib/prisma";
import { deleteUploadedFile, MAX_UPLOAD_BYTES, saveReceipt } from "@/lib/uploads/storage";

// PRD §4.12 "attachment": one receipt per expense (image or PDF), stored
// under expenses/<id>/ and served only to expense.view (app/uploads route).
// Replacing or removing it is audit-logged (CLAUDE.md rule 7).

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(["expense.create", "expense.edit"]);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const expense = await prisma.expense.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!expense) return NextResponse.json({ error: "Expense not found" }, { status: 404 });

  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (!(EXPENSE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.type)) {
    return NextResponse.json({ error: "Attach a photo (JPG, PNG, WebP) or a PDF" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: `${file.name} exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit` }, { status: 400 });
  }

  let saved: { filePath: string; mimeType: string };
  try {
    saved = await saveReceipt(Buffer.from(await file.arrayBuffer()), file.type, `expenses/${id}`);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read that file" }, { status: 400 });
  }
  try {
    const replaced = await prisma.$transaction((tx) => setExpenseAttachment(tx, id, { path: saved.filePath, mime: saved.mimeType, name: file.name.slice(0, 120) }, guard.user.id));
    if (replaced) await deleteUploadedFile(replaced);
    return NextResponse.json({ attachmentPath: saved.filePath, attachmentMime: saved.mimeType, attachmentName: file.name.slice(0, 120) }, { status: 201 });
  } catch (error) {
    await deleteUploadedFile(saved.filePath);
    return financeErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("expense.edit");
  if (!guard.ok) return guard.response;
  const { id } = await params;
  try {
    const removed = await prisma.$transaction((tx) => setExpenseAttachment(tx, id, null, guard.user.id));
    if (removed) await deleteUploadedFile(removed);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return financeErrorResponse(error);
  }
}
