import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/audit/log";
import { requirePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/prisma";
import { getBusinessProfile, saveBusinessProfile } from "@/lib/settings/business-profile";
import { BUSINESS_PROFILE_SETTING_KEY } from "@/lib/settings/business-profile-shape";
import { deleteUploadedFile, isAllowedImageMime, MAX_UPLOAD_BYTES, saveLogo } from "@/lib/uploads/storage";

// The business logo: one PNG under uploads/branding/, served through the
// auth-checked uploads route like every other file, and inlined into the
// PDFs when they render. Replacing it removes the old file.

export async function POST(request: NextRequest) {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose an image" }, { status: 400 });
  if (!isAllowedImageMime(file.type)) return NextResponse.json({ error: "The logo must be a JPEG, PNG or WebP image" }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: `The logo must be ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB or smaller` }, { status: 400 });

  let logoPath: string;
  try {
    logoPath = await saveLogo(Buffer.from(await file.arrayBuffer()), file.type);
  } catch {
    return NextResponse.json({ error: "That file couldn't be read as an image" }, { status: 400 });
  }
  const before = await getBusinessProfile(prisma);
  await saveBusinessProfile(prisma, { ...before, logoPath }, guard.user.id);
  if (before.logoPath) await deleteUploadedFile(before.logoPath);
  await writeAuditLog({ actorId: guard.user.id, action: "setting.logo_upload", entityType: "setting", entityId: BUSINESS_PROFILE_SETTING_KEY, before: { logoPath: before.logoPath }, after: { logoPath }, request });
  return NextResponse.json({ logoPath });
}

export async function DELETE(request: NextRequest) {
  const guard = await requirePermission("settings.manage");
  if (!guard.ok) return guard.response;
  const before = await getBusinessProfile(prisma);
  if (!before.logoPath) return NextResponse.json({ logoPath: null });
  await saveBusinessProfile(prisma, { ...before, logoPath: null }, guard.user.id);
  await deleteUploadedFile(before.logoPath);
  await writeAuditLog({ actorId: guard.user.id, action: "setting.logo_delete", entityType: "setting", entityId: BUSINESS_PROFILE_SETTING_KEY, before: { logoPath: before.logoPath }, after: { logoPath: null }, request });
  return NextResponse.json({ logoPath: null });
}
