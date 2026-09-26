import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Browser } from "puppeteer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { renderPriceTagsHtml } from "@/lib/catalog/price-tags";
import { findLabelStock } from "@/lib/catalog/price-tag-layout";
import { renderInvoiceHtml } from "@/lib/orders/invoice";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";
import { loadPackingOrder, serializePackingOrderDetail } from "@/lib/packing/queue";
import { renderPackingSlipHtml } from "@/lib/packing/slip";
import { getFontFaceCss, renderHtmlToPdf } from "@/lib/pdf/render";
import { loadReceiptOrder, renderReceiptHtml } from "@/lib/pos/receipt";
import { renderReportHtml } from "@/lib/reports/export";
import type { ReportResult } from "@/lib/reports/types";
import { testProductCode, testSku } from "@/lib/test/catalog-codes";
import { freshPhone, PHONES, userFor } from "@/lib/test/returns-fixtures";
import { inRolledBackTransaction } from "@/lib/test/rollback";

// PRD §4.18 — "Bangla text renders correctly everywhere including PDFs
// (embedded Bangla font)". Every PDF the app makes — A4 invoice, packing
// slip, 80 mm receipt, price tags, report export — is rendered from real
// records carrying Bangla (conjuncts, vowel signs, ZWJ, the danda, ৳), and
// two things are checked:
//
//  1. Chromium drew every character with the embedded font. A glyph that
//     falls back to a system font looks fine on a Mac and prints as a box
//     on the Linux server, which has no Bangla fonts.
//  2. The PDF embeds that font and no other.
//
// PDF_CHECK_OUT=<dir> also writes each PDF and a PNG of it there to look at.

const BN = {
  customer: "সুমাইয়া আক্তার",
  address: "বাড়ি ১২, রোড ৫, ধানমন্ডি",
  thana: "ধানমন্ডি",
  district: "ঢাকা",
  product: "জামদানি শাড়ি — লক্ষ্মী",
  note: "ডেলিভারির আগে ফোন করবেন। র‍্যাব গেটের পাশে।",
  conjuncts: "ক্ষ্ম স্ত্র ন্দ্র ঞ্জ হ্ম শ্রী কৃষ্ণ",
  money: "৳ ১,৪২,০০০",
};

const OUT = process.env.PDF_CHECK_OUT;

let browser: Browser;
beforeAll(async () => {
  const puppeteer = await import("puppeteer");
  browser = await puppeteer.default.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

type Fallback = { font: string; text: string };

/** Every element whose text Chromium drew with a system font instead of the embedded one. */
async function systemFontFallbacks(html: string, name: string): Promise<Fallback[]> {
  const page = await browser.newPage();
  try {
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    if (OUT) await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
    const cdp = await page.createCDPSession();
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    type Node = { nodeId: number; nodeType: number; nodeName: string; children?: Node[] };
    const elements: Node[] = [];
    const walk = (n: Node) => {
      if (n.nodeType === 1 && !["HTML", "HEAD", "STYLE", "SCRIPT", "META", "TITLE"].includes(n.nodeName)) elements.push(n);
      n.children?.forEach(walk);
    };
    walk(root as Node);
    const out: Fallback[] = [];
    for (const el of elements) {
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: el.nodeId });
      const system = fonts.filter((f) => !f.isCustomFont && f.glyphCount > 0);
      if (system.length === 0) continue;
      const { outerHTML } = await cdp.send("DOM.getOuterHTML", { nodeId: el.nodeId });
      const text = outerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
      for (const f of system) out.push({ font: f.familyName, text });
    }
    return out;
  } finally {
    await page.close();
  }
}

/** Font names the PDF embeds (its /BaseFont entries). */
function embeddedFonts(pdf: Uint8Array): string[] {
  const text = Buffer.from(pdf).toString("latin1");
  return [...new Set([...text.matchAll(/\/BaseFont\s*\/([^\s/<>[\]]+)/g)].map((m) => m[1].replace(/^[A-Z]{6}\+/, "")))];
}

async function check(name: string, html: string, pdf: Uint8Array) {
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, `${name}.pdf`), pdf);
  }
  expect(await systemFontFallbacks(html, name), `${name}: characters drawn with a system font`).toEqual([]);
  const fonts = embeddedFonts(pdf);
  expect(fonts.length, `${name}: no font embedded`).toBeGreaterThan(0);
  expect(fonts.filter((f) => !f.startsWith("NotoSansBengali")), `${name}: fonts other than the embedded Noto Sans Bengali`).toEqual([]);
  // The Bangla actually reached the page (not dropped or escaped away).
  expect(html).toContain(BN.product);
  expect(html, `${name}: a typed arrow the fonts can't draw`).not.toMatch(/[↳✓]/);
}

describe("every PDF renders Bangla with the embedded font (PRD §4.18)", () => {
  it("invoice, packing slip, receipt, price tags and report export", () =>
    inRolledBackTransaction(async (tx) => {
      const [se, pos] = await Promise.all([userFor(tx, PHONES.SE), userFor(tx, PHONES.POS)]);
      const [size, color] = await Promise.all([tx.size.findFirstOrThrow(), tx.color.findFirstOrThrow()]);
      const code = testProductCode();
      const product = await tx.product.create({ data: { code, name: BN.product, basePrice: 142000, description: BN.conjuncts } });
      const variant = await tx.productVariant.create({ data: { productId: product.id, sizeId: size.id, colorId: color.id, sku: testSku(code) } });
      const customer = await tx.customer.create({
        data: { name: BN.customer, phone: freshPhone(), division: "ঢাকা", district: BN.district, thana: BN.thana, addressDetail: BN.address, createdById: se.id, teamId: se.teamId },
      });
      // One plain line and one outfit set (its piece prints with the sub-item mark).
      const outfit = await tx.outfitSet.create({ data: { name: `সেট: ${BN.product}`, price: 5000 } });
      const withLines = async (orderId: string) => {
        await tx.orderItem.create({ data: { orderId, variantId: variant.id, qty: 1, unitPrice: 142000 } });
        const setLine = await tx.orderSetLine.create({ data: { orderId, outfitSetId: outfit.id, name: outfit.name, qty: 1, unitPrice: 5000 } });
        await tx.orderItem.create({ data: { orderId, variantId: variant.id, qty: 1, unitPrice: 5000, setLineId: setLine.id } });
      };
      const base = { subtotal: 147000, total: 147080, dueAmount: 147080, customerId: customer.id };
      const online = await tx.order.create({
        data: { ...base, orderNo: `TEST-BN-${Date.now()}`, status: "CONFIRMED", deliveryCharge: 80, deliveryNote: BN.note, internalNote: BN.conjuncts, createdById: se.id, teamId: se.teamId },
      });
      const walkIn = await tx.order.create({
        data: { ...base, total: 147000, dueAmount: 147000, orderNo: `TEST-BNW-${Date.now()}`, channel: "WALK_IN", status: "COMPLETED", createdById: pos.id, teamId: pos.teamId },
      });
      await withLines(online.id);
      await withLines(walkIn.id);
      const css = await getFontFaceCss();

      // A4 invoice
      const invoiceHtml = await renderInvoiceHtml(serializeOrderDetail((await loadOrderDetail(online.id, tx))!), 1, css);
      await check("invoice", invoiceHtml, await renderHtmlToPdf(invoiceHtml));

      // Packing slip
      const slipHtml = await renderPackingSlipHtml(serializePackingOrderDetail((await loadPackingOrder(online.id, tx))!, 24), css);
      await check("packing-slip", slipHtml, await renderHtmlToPdf(slipHtml));

      // 80 mm receipt (its own thank-you line is Bangla too)
      const receiptHtml = renderReceiptHtml((await loadReceiptOrder(tx, walkIn.id))!, css);
      await check("receipt", receiptHtml, await renderHtmlToPdf(receiptHtml, { widthMm: 80, heightMm: 200 }));

      // Price tags
      const stock = findLabelStock("roll-50x25")!;
      const tags = await renderPriceTagsHtml([{ sku: variant.sku, productName: BN.product, sizeName: size.name, colorName: color.name, price: "142000" }], stock, 203, 1);
      await check("price-tags", tags.html, await renderHtmlToPdf(tags.html, { widthMm: tags.pageW, heightMm: tags.pageH }));

      // Report export
      const report: ReportResult = {
        key: "sales",
        code: "R1",
        title: "Sales",
        period: { fromDay: "2026-09-01", toDay: "2026-09-25" },
        applied: [{ label: "Customer", value: BN.customer }],
        figures: [{ label: "বিক্রি", value: 142000, format: "money" }],
        tables: [{ id: "t", title: BN.product, columns: [{ key: "name", label: "নাম" }, { key: "value", label: "মূল্য", format: "money" }], rows: [{ name: `${BN.conjuncts} ${BN.money}`, value: 142000 }] }],
        notes: [BN.note],
        generatedAt: new Date().toISOString(),
      };
      const reportHtml = await renderReportHtml(report);
      await check("report", reportHtml, await renderHtmlToPdf(reportHtml, undefined, { marginMm: 10 }));
    }), 120_000);
});
