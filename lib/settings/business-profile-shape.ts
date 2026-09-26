// PRD §4.17 business profile — what the invoice, packing slip and showroom
// receipt print at the top and bottom. One JSON value in `settings`
// (lib/settings/business-profile.ts). Client- and server-safe.

import { z } from "zod";

export const BUSINESS_PROFILE_SETTING_KEY = "business_profile";

const line = (max: number) => z.string().trim().max(max);

export const businessProfileSchema = z.object({
  name: line(80).min(2, "Give the business a name"),
  /** Printed under the name — Bangla is fine. */
  tagline: line(120),
  address: line(300),
  phone: line(60),
  email: line(120).refine((v) => v === "" || z.email().safeParse(v).success, "Enter a valid email address"),
  /** The thank-you line at the foot of the invoice and the receipt. */
  invoiceFooter: line(300),
});

export type BusinessProfileInput = z.infer<typeof businessProfileSchema>;

export type BusinessProfile = BusinessProfileInput & {
  /** Relative to UPLOAD_ROOT (branding/…), or null for no logo. Set only by the logo upload route. */
  logoPath: string | null;
};

/** What every document printed before Settings existed. */
export const DEFAULT_BUSINESS_PROFILE: BusinessProfile = {
  name: "Antu Boutique",
  tagline: "অনলাইন ও শোরুম ফ্যাশন বুটিক",
  address: "",
  phone: "",
  email: "",
  invoiceFooter: "ধন্যবাদ আমাদের সাথে কেনাকাটা করার জন্য",
  logoPath: null,
};

/** A stored value that is missing, unparsable or partly invalid falls back field by field. */
export function parseBusinessProfile(raw: string | null): BusinessProfile {
  if (!raw) return DEFAULT_BUSINESS_PROFILE;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_BUSINESS_PROFILE;
  }
  const parsed = businessProfileSchema.partial().safeParse(value);
  const logoPath = typeof (value as { logoPath?: unknown })?.logoPath === "string" ? (value as { logoPath: string }).logoPath : null;
  if (!parsed.success) return { ...DEFAULT_BUSINESS_PROFILE, logoPath };
  return { ...DEFAULT_BUSINESS_PROFILE, ...parsed.data, logoPath };
}

/** What a PDF needs: the profile plus the logo inlined, because Chromium renders with no access to /uploads. */
export type DocumentBranding = BusinessProfile & { logoDataUri: string | null };

export const DEFAULT_DOCUMENT_BRANDING: DocumentBranding = { ...DEFAULT_BUSINESS_PROFILE, logoDataUri: null };
