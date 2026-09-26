import "server-only";

import type { Db } from "@/lib/db/tx";
import { BUSINESS_PROFILE_SETTING_KEY, parseBusinessProfile, type BusinessProfile, type DocumentBranding } from "@/lib/settings/business-profile-shape";
import { readUploadedFile } from "@/lib/uploads/storage";

// Read with defaults, so documents print the same as before until Settings
// has been filled in.

export async function getBusinessProfile(db: Db): Promise<BusinessProfile> {
  const row = await db.setting.findUnique({ where: { key: BUSINESS_PROFILE_SETTING_KEY } });
  return parseBusinessProfile(row?.value ?? null);
}

export async function saveBusinessProfile(db: Db, profile: BusinessProfile, updatedById: string): Promise<void> {
  const value = JSON.stringify(profile);
  await db.setting.upsert({ where: { key: BUSINESS_PROFILE_SETTING_KEY }, update: { value, updatedById }, create: { key: BUSINESS_PROFILE_SETTING_KEY, value, updatedById } });
}

/** The profile with its logo as a data: URI. A logo file that has gone missing just prints no logo. */
export async function getDocumentBranding(db: Db): Promise<DocumentBranding> {
  const profile = await getBusinessProfile(db);
  if (!profile.logoPath) return { ...profile, logoDataUri: null };
  try {
    const bytes = await readUploadedFile(profile.logoPath);
    return { ...profile, logoDataUri: `data:image/png;base64,${bytes.toString("base64")}` };
  } catch {
    return { ...profile, logoDataUri: null };
  }
}
