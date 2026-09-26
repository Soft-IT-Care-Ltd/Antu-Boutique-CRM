import { escapeHtml } from "@/lib/pdf/render";
import type { DocumentBranding } from "@/lib/settings/business-profile-shape";

// The business block at the top of the invoice and packing slip (PRD §4.17
// business profile). The branding is loaded by
// lib/settings/business-profile.ts; a renderer called without it (tests)
// prints DEFAULT_DOCUMENT_BRANDING — what every document said before P5.2.

/** Logo (if any), name, tagline, and — on the invoice — address and phone. */
export function brandBlockHtml(branding: DocumentBranding, { contact }: { contact: boolean }): string {
  const contactLines = contact
    ? [branding.address, [branding.phone, branding.email].filter(Boolean).join(" · ")].filter(Boolean).map((l) => `<div class="tag">${escapeHtml(l)}</div>`).join("")
    : "";
  const logo = branding.logoDataUri ? `<img class="logo" src="${branding.logoDataUri}" alt="" />` : "";
  return `${logo}<div>${escapeHtml(branding.name)}${branding.tagline ? `<div class="tag">${escapeHtml(branding.tagline)}</div>` : ""}${contactLines}</div>`;
}

/** Shared style for the block: logo beside the name. */
export const BRAND_BLOCK_CSS = `.business { display: flex; gap: 12px; align-items: flex-start; } .business .logo { max-height: 56px; max-width: 160px; object-fit: contain; } .business .tag { font-size: 11px; font-weight: 400; }`;
