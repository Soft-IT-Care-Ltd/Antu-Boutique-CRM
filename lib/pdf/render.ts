import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Browser } from "puppeteer";

// Shared by lib/orders/invoice.ts and lib/packing/slip.ts — both render
// business documents (invoice, packing slip) with Bangla text, and both
// need Chromium's HarfBuzz text shaping to get Bangla conjuncts/vowel-sign
// reordering right (see the longer comment this was extracted from in
// invoice.ts's git history). One lazily-started browser and one cached
// font-face CSS string, shared by every document type, not one per type —
// this is a low-volume internal CRM, not a multi-tenant service.

const FONT_DIR = path.resolve(process.cwd(), "assets/fonts");

const FONT_FILES = {
  regularBengali: "NotoSansBengali-Regular.woff2",
  regularLatin: "NotoSansBengali-Latin-Regular.woff2",
  boldBengali: "NotoSansBengali-Bold.woff2",
  boldLatin: "NotoSansBengali-Latin-Bold.woff2",
} as const;

let cachedFontFaceCss: Promise<string> | null = null;

// Fonts are embedded as base64 data: URIs directly in the HTML rather than
// referenced by file:// path — Puppeteer's page.setContent() has no base
// URL, so a relative/file path resolution is one more thing that can break
// across environments (dev machine vs VPS). Inlining removes that entirely.
export async function getFontFaceCss(): Promise<string> {
  if (!cachedFontFaceCss) {
    cachedFontFaceCss = (async () => {
      const entries = await Promise.all(
        Object.entries(FONT_FILES).map(async ([key, filename]) => {
          const buffer = await readFile(path.join(FONT_DIR, filename));
          return [key, buffer.toString("base64")] as const;
        }),
      );
      const b64 = Object.fromEntries(entries) as Record<keyof typeof FONT_FILES, string>;
      const face = (weight: 400 | 700, base64: string, unicodeRange: string) => `
        @font-face {
          font-family: 'Invoice Sans';
          font-weight: ${weight};
          font-style: normal;
          src: url(data:font/woff2;base64,${base64}) format('woff2');
          unicode-range: ${unicodeRange};
        }`;
      // The danda and double danda (U+0964-0965, "।" "॥") are Bangla's full
      // stop but sit in the Devanagari block. Without them here Chromium drew
      // them from a system font — fine on a Mac, an empty box on the server,
      // which has no Bangla fonts (P5.1 Bangla PDF check).
      const BENGALI_RANGE = "U+0964-0965, U+0980-09FE, U+200C-200D, U+25CC";
      const LATIN_RANGE = "U+0000-00FF, U+2000-206F, U+20AC";
      return [
        face(400, b64.regularBengali, BENGALI_RANGE),
        face(400, b64.regularLatin, LATIN_RANGE),
        face(700, b64.boldBengali, BENGALI_RANGE),
        face(700, b64.boldLatin, LATIN_RANGE),
      ].join("\n");
    })();
  }
  return cachedFontFaceCss;
}

let browserPromise: Promise<Browser> | null = null;
async function getPdfBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const puppeteer = await import("puppeteer");
    browserPromise = puppeteer.default.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browserPromise;
}

/**
 * "One piece of the set above" (outfit-set components on the invoice,
 * packing slip and receipt). Drawn, not typed: the embedded fonts have no
 * arrow glyph, and the server has no system font to fall back on, so "↳"
 * printed as an empty box there (P5.1 Bangla PDF check).
 */
export const SUB_ITEM_MARK =
  '<svg width="0.8em" height="0.8em" viewBox="0 0 10 10" style="vertical-align:-0.05em;margin-right:0.25em" aria-hidden="true"><path d="M2 0.5v5.5h6.5M6 3.5l2.5 2.5-2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function escapeHtml(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatPdfDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Dhaka" });
}

/**
 * Renders a complete HTML document (fonts already inlined) to a PDF buffer —
 * A4 unless a page size is given (P3.1 price tags: one label per page, at
 * the label's exact size, so a label printer prints it 1:1). With a page
 * size, the document's own @page size wins: from the width/height options
 * Chrome made a 60 mm label 60.37 mm wide and shifted its content by a
 * fraction of a printer dot, taking the barcode off the dot grid (C5).
 */
export async function renderHtmlToPdf(html: string, pageSize?: { widthMm: number; heightMm: number }, opts: { landscape?: boolean; marginMm?: number } = {}): Promise<Uint8Array> {
  const browser = await getPdfBrowser();
  const page = await browser.newPage();
  try {
    // Paper is white whatever the host's theme: a Mac in dark mode otherwise
    // printed these on a dark page (P5.1).
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    // Fonts are inlined as base64 data: URIs and nothing else is fetched,
    // so there's no network activity to wait out — "load" is enough.
    await page.setContent(html, { waitUntil: "load" });
    const size = pageSize ? { width: `${pageSize.widthMm}mm`, height: `${pageSize.heightMm}mm` } : { format: "A4" as const };
    // P4.4 reports run to many pages: a margin on every page (not just body
    // padding, which only pads the first and last).
    const m = `${opts.marginMm ?? 0}mm`;
    return await page.pdf({ ...size, landscape: opts.landscape ?? false, printBackground: true, margin: { top: m, bottom: m, left: m, right: m }, preferCSSPageSize: Boolean(pageSize) });
  } finally {
    await page.close();
  }
}

/**
 * P3.1 thermal receipts: a PDF `widthMm` wide and exactly as tall as its
 * content — receipt paper is a continuous roll, so the printer cuts where
 * the receipt ends instead of feeding a blank A4-length page.
 */
export async function renderHtmlToPdfFitHeight(html: string, widthMm: number): Promise<Uint8Array> {
  const browser = await getPdfBrowser();
  const page = await browser.newPage();
  try {
    // Lay the page out at the paper's width before measuring its height.
    await page.setViewport({ width: Math.ceil((widthMm * 96) / 25.4), height: 800 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.setContent(html, { waitUntil: "load" });
    const heightPx = await page.evaluate(() => Math.ceil(document.documentElement.getBoundingClientRect().height));
    const heightMm = Math.ceil((heightPx * 25.4) / 96) + 2;
    return await page.pdf({ width: `${widthMm}mm`, height: `${heightMm}mm`, printBackground: true, margin: { top: "0", bottom: "0", left: "0", right: "0" } });
  } finally {
    await page.close();
  }
}
