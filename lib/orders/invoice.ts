import "server-only";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@/lib/prisma";
import { formatBDT } from "@/lib/money";
import { escapeHtml, formatPdfDate as formatInvoiceDate, getFontFaceCss, renderHtmlToPdf, SUB_ITEM_MARK } from "@/lib/pdf/render";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";
import { PAYMENT_METHOD_LABELS } from "@/lib/orders/constants";
import { WALK_IN_CUSTOMER_LABEL } from "@/lib/orders/customer";
import { keptLine } from "@/lib/orders/totals";
import { resolveUploadPath } from "@/lib/uploads/storage";
import type { OrderDetail } from "@/lib/orders/types";

// PRD §7 "PDF invoice + packing slip with an embedded Bangla font." Plain
// Node PDF libraries (pdfkit, @react-pdf/renderer) map Unicode codepoints to
// glyphs one-for-one and have no Indic shaping engine, so Bangla conjuncts
// and vowel-sign reordering come out wrong. Chromium (via Puppeteer) shapes
// text with HarfBuzz like any browser does, so it's the only practical way
// to get Bangla right — see the CLAUDE.md/BUILD_PROMPTS decision for P1.4.
// The font-loading/browser plumbing itself lives in lib/pdf/render.ts,
// shared with lib/packing/slip.ts's packing slip.

export async function renderInvoiceHtml(order: OrderDetail, version: number, fontFaceCss: string): Promise<string> {
  // Same rule as due_amount: a refund only counts once approved.
  const paid = order.payments.filter((p) => p.kind === "PAYMENT" || p.refundStatus === "APPROVED").reduce((sum, p) => sum + Number(p.amount), 0);
  // P3.1 — a showroom sale: no delivery address, maybe no customer at all.
  const isWalkIn = order.channel === "WALK_IN";
  const address = order.customer
    ? [order.customer.addressDetail, order.customer.thana, order.customer.district, order.customer.division].filter(Boolean).join(", ")
    : "";
  const billedTo = order.customer
    ? `<p><strong>${escapeHtml(order.customer.name)}</strong></p>
      <p>${escapeHtml(order.customer.phone)}</p>
      ${isWalkIn ? "" : `<p>${escapeHtml(address || "—")}</p>`}`
    : `<p><strong>${WALK_IN_CUSTOMER_LABEL}</strong></p>`;
  // How a counter sale was paid (split tender), so the receipt shows it.
  const paymentLines = isWalkIn
    ? order.payments
        .filter((p) => p.kind === "PAYMENT")
        .map((p) => `<div class="muted"><span>${escapeHtml(PAYMENT_METHOD_LABELS[p.method])}${p.transactionId ? ` · ${escapeHtml(p.transactionId)}` : ""}</span><span>${formatBDT(p.amount)}</span></div>`)
        .join("")
    : "";

  // After a partial delivery (P2.2) the invoice bills what the customer
  // kept: kept quantity, pro-rated discount, with the returned units noted.
  const plainRows = order.items
    .filter((item) => item.setLineId === null)
    .map((item) => {
      const line = keptLine({ qty: item.qty, returnedQty: item.returnedQty, unitPrice: Number(item.unitPrice), lineDiscount: Number(item.lineDiscount) });
      const returnedNote = item.returnedQty > 0 ? `<div class="muted">${item.qty} sent, ${item.returnedQty} returned</div>` : "";
      return `
      <tr>
        <td>${escapeHtml(item.productName)}<div class="muted">${escapeHtml(item.sku)}</div></td>
        <td>${escapeHtml(item.sizeName)}</td>
        <td>${escapeHtml(item.colorName)}</td>
        <td class="num">${line.qty}${returnedNote}</td>
        <td class="num">${formatBDT(item.unitPrice)}</td>
        <td class="num">${formatBDT(line.lineDiscount)}</td>
        <td class="num">${formatBDT(item.lineTotal)}</td>
      </tr>`;
    })
    .join("");
  // P3.3 (Gift Valy Round 2 §2.2) — an outfit set prints as the set, with an
  // indented list of what's in it: names, size, colour and quantity only,
  // never the components' prices or costs.
  const setRows = order.setLines
    .map((set) => {
      const components = order.items.filter((i) => i.setLineId === set.id);
      const total = components.reduce((sum, i) => sum + Math.round(Number(i.lineTotal) * 100), 0) / 100;
      const returned = components.some((i) => i.returnedQty > 0);
      const inside = components
        .map(
          (i) => `
      <tr class="component">
        <td>${SUB_ITEM_MARK}${escapeHtml(i.productName)}<div class="muted">${escapeHtml(i.sku)}${i.returnedQty > 0 ? ` · ${i.returnedQty} returned` : ""}</div></td>
        <td>${escapeHtml(i.sizeName)}</td>
        <td>${escapeHtml(i.colorName)}</td>
        <td class="num">${i.qty - i.returnedQty}</td>
        <td colspan="3"></td>
      </tr>`,
        )
        .join("");
      return `
      <tr>
        <td><strong>${escapeHtml(set.name)}</strong><div class="muted">Outfit set${returned ? " · part returned" : ""}</div></td>
        <td></td>
        <td></td>
        <td class="num">${set.qty}</td>
        <td class="num">${formatBDT(set.unitPrice)}</td>
        <td class="num">${formatBDT(set.lineDiscount)}</td>
        <td class="num">${formatBDT(total)}</td>
      </tr>${inside}`;
    })
    .join("");
  const rows = plainRows + setRows;

  return `<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8" />
<style>
  ${fontFaceCss}
  * { box-sizing: border-box; }
  body { font-family: 'Invoice Sans', sans-serif; font-size: 12px; color: #111; margin: 0; padding: 32px; }
  tr.component td { padding-left: 18px; font-size: 11px; border-top: none; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 12px; margin-bottom: 16px; }
  .business { font-size: 20px; font-weight: 700; }
  .tag { color: #555; }
  .invoice-title { text-align: right; }
  .invoice-title h1 { font-size: 18px; margin: 0 0 4px; }
  .invoice-title .version { color: #555; }
  .grid { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 20px; }
  .box h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; margin: 0 0 6px; }
  .box p { margin: 0; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #555; border-bottom: 2px solid #111; }
  td.num, th.num { text-align: right; }
  .muted { color: #777; font-size: 10px; }
  .totals { width: 260px; margin-left: auto; }
  .totals div { display: flex; justify-content: space-between; padding: 4px 0; }
  .totals .grand { font-weight: 700; border-top: 1px solid #111; margin-top: 4px; padding-top: 8px; }
  .totals .due { font-weight: 700; }
  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #ddd; color: #555; font-size: 10px; text-align: center; }
</style>
</head>
<body>
  <div class="header">
    <div class="business">
      Antu Boutique
      <div class="tag">অনলাইন ও শোরুম ফ্যাশন বুটিক</div>
    </div>
    <div class="invoice-title">
      <h1>Invoice</h1>
      <div class="version">${escapeHtml(order.orderNo)} &middot; Version ${version}</div>
    </div>
  </div>

  <div class="grid">
    <div class="box">
      <h2>Billed to</h2>
      ${billedTo}
    </div>
    <div class="box">
      <h2>Order details</h2>
      <p>Order date: ${formatInvoiceDate(order.createdAt)}</p>
      <p>Channel: ${order.channel === "ONLINE" ? "Online" : "Walk-in (showroom)"}</p>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Item</th>
        <th>Size</th>
        <th>Colour</th>
        <th class="num">Qty</th>
        <th class="num">Unit price</th>
        <th class="num">Discount</th>
        <th class="num">Line total</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <div class="totals">
    <div><span>Subtotal</span><span>${formatBDT(order.subtotal)}</span></div>
    <div><span>Discount</span><span>- ${formatBDT(order.discountTotal)}</span></div>
    ${isWalkIn ? "" : `<div><span>Delivery charge</span><span>${formatBDT(order.deliveryCharge)}</span></div>`}
    <div class="grand"><span>Total</span><span>${formatBDT(order.total)}</span></div>
    <div><span>Paid</span><span>${formatBDT(paid)}</span></div>
    ${paymentLines}
    <div class="due"><span>Due</span><span>${formatBDT(order.dueAmount)}</span></div>
  </div>

  <div class="footer">
    Antu Boutique &middot; ধন্যবাদ আমাদের সাথে কেনাকাটা করার জন্য &middot; This is a system-generated invoice.
  </div>
</body>
</html>`;
}

/**
 * Renders and persists a new invoice version for the order's CURRENT
 * state, and inserts the corresponding `invoices` row. Called after order
 * creation (version 1) and after any applied gated edit — direct in-window
 * or an approved edit-request (PRD §6 rule 8: "an approved order edit
 * regenerates the invoice as a new version; old versions are retained").
 * Never overwrites a prior version's file.
 */
export async function generateOrderInvoice(orderId: string, generatedById: string | null) {
  const loaded = await loadOrderDetail(orderId);
  if (!loaded) throw new Error(`Order ${orderId} not found`);
  const order = serializeOrderDetail(loaded);

  const maxVersion = await prisma.invoice.aggregate({ where: { orderId }, _max: { version: true } });
  const version = (maxVersion._max.version ?? 0) + 1;

  const fontFaceCss = await getFontFaceCss();
  const html = await renderInvoiceHtml(order, version, fontFaceCss);
  const pdfBuffer = await renderHtmlToPdf(html);

  const subdir = `orders/${order.orderNo}/invoices`;
  const dir = resolveUploadPath(subdir);
  await mkdir(dir, { recursive: true });
  const filename = `v${version}.pdf`;
  await writeFile(path.join(dir, filename), pdfBuffer);
  const filePath = path.posix.join(subdir, filename);

  return prisma.invoice.create({
    data: { orderId, version, filePath, generatedById },
  });
}
