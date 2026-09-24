import "server-only";

import { WALK_IN_CUSTOMER_LABEL } from "@/lib/orders/customer";
import { PAYMENT_METHOD_LABELS } from "@/lib/orders/constants";
import { fromPaisa, toPaisa } from "@/lib/inventory/costing";
import { formatBDT } from "@/lib/money";
import { escapeHtml, getFontFaceCss, renderHtmlToPdfFitHeight } from "@/lib/pdf/render";
import type { Db } from "@/lib/db/tx";

// P3.1 — the 80 mm thermal receipt for a walk-in sale, printed at the
// counter right after the sale (the A4 invoice stays available as an
// option). 80 mm paper prints 72 mm wide; Bangla renders through the same
// embedded font as the invoice. Selling prices only — never cost.

export const RECEIPT_PAPER_MM = 80;
const PRINTABLE_MM = 72;

export type ReceiptOrder = NonNullable<Awaited<ReturnType<typeof loadReceiptOrder>>>;

export async function loadReceiptOrder(db: Db, orderId: string) {
  return db.order.findFirst({
    where: { id: orderId, deletedAt: null, channel: "WALK_IN" },
    select: {
      orderNo: true,
      createdAt: true,
      subtotal: true,
      discountTotal: true,
      total: true,
      createdBy: { select: { name: true } },
      customer: { select: { name: true, phone: true } },
      items: {
        orderBy: { createdAt: "asc" },
        select: {
          qty: true,
          unitPrice: true,
          lineDiscount: true,
          setLineId: true,
          variant: { select: { sku: true, product: { select: { name: true } }, size: { select: { name: true } }, color: { select: { name: true } } } },
        },
      },
      // P3.3 — outfit sets print as the set, with what's in it.
      setLines: { orderBy: { createdAt: "asc" }, select: { id: true, name: true, qty: true, unitPrice: true, lineDiscount: true } },
      // P3.2 — store credit spent at the counter prints like any payment.
      payments: { where: { OR: [{ kind: "PAYMENT" }, { kind: "STORE_CREDIT", amount: { gt: 0 } }] }, orderBy: { createdAt: "asc" }, select: { method: true, amount: true, cashTendered: true, transactionId: true } },
    },
  });
}

const DHAKA_RECEIPT_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });

/** 01711000004 → 017•••••004: enough for the customer to recognise, not a full number on a slip of paper. */
function maskPhone(phone: string): string {
  return phone.length > 6 ? `${phone.slice(0, 3)}${"•".repeat(phone.length - 6)}${phone.slice(-3)}` : phone;
}

const row = (left: string, right: string, cls = "") => `<div class="row ${cls}"><span>${left}</span><span>${right}</span></div>`;

export function renderReceiptHtml(order: ReceiptOrder, fontFaceCss: string): string {
  const setsHtml = order.setLines
    .map((set) => {
      const gross = set.qty * toPaisa(set.unitPrice);
      const discount = toPaisa(set.lineDiscount);
      const inside = order.items
        .filter((i) => i.setLineId === set.id)
        .map((i) => `<div class="muted">↳ ${i.qty} × ${escapeHtml(i.variant.product.name)} · ${escapeHtml(i.variant.size.name)} · ${escapeHtml(i.variant.color.name)}</div>`)
        .join("");
      return `
      <div class="item">
        <div class="name">${escapeHtml(set.name)}</div>
        ${inside}
        ${row(`${set.qty} × ${formatBDT(set.unitPrice)}`, formatBDT(fromPaisa(gross)))}
        ${discount > 0 ? row("Discount", `− ${formatBDT(fromPaisa(discount))}`, "muted") : ""}
      </div>`;
    })
    .join("");
  const items = order.items
    .filter((item) => item.setLineId === null)
    .map((item) => {
      const gross = item.qty * toPaisa(item.unitPrice);
      const discount = toPaisa(item.lineDiscount);
      return `
      <div class="item">
        <div class="name">${escapeHtml(item.variant.product.name)}</div>
        <div class="muted">${escapeHtml(item.variant.size.name)} · ${escapeHtml(item.variant.color.name)} · ${escapeHtml(item.variant.sku)}</div>
        ${row(`${item.qty} × ${formatBDT(item.unitPrice)}`, formatBDT(fromPaisa(gross)))}
        ${discount > 0 ? row("Discount", `− ${formatBDT(fromPaisa(discount))}`, "muted") : ""}
      </div>`;
    })
    .join("") + setsHtml;

  let change = 0;
  const payments = order.payments
    .map((p) => {
      const trx = p.transactionId ? ` · ${escapeHtml(p.transactionId)}` : "";
      let lines = row(`${escapeHtml(PAYMENT_METHOD_LABELS[p.method])}${trx}`, formatBDT(p.amount));
      if (p.method === "CASH" && p.cashTendered) {
        const given = toPaisa(p.cashTendered);
        change += given - toPaisa(p.amount);
        lines += row("Cash given", formatBDT(p.cashTendered), "muted");
      }
      return lines;
    })
    .join("");

  const customer = order.customer ? `${escapeHtml(order.customer.name)} · ${maskPhone(order.customer.phone)}` : WALK_IN_CUSTOMER_LABEL;
  const itemCount = order.items.reduce((a, i) => a + i.qty, 0);

  return `<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8" />
<style>
  ${fontFaceCss}
  @page { size: ${RECEIPT_PAPER_MM}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { width: ${RECEIPT_PAPER_MM}mm; padding: 3mm ${(RECEIPT_PAPER_MM - PRINTABLE_MM) / 2}mm 4mm; font-family: 'Invoice Sans', sans-serif; font-size: 9pt; line-height: 1.35; color: #000; }
  .center { text-align: center; }
  .shop { font-size: 14pt; font-weight: 700; letter-spacing: 0.04em; }
  .muted { color: #333; font-size: 8pt; }
  .rule { border-top: 1px dashed #000; margin: 2mm 0; }
  .row { display: flex; justify-content: space-between; gap: 2mm; }
  .row span:last-child { white-space: nowrap; text-align: right; }
  .item { margin-bottom: 1.5mm; }
  .item .name { font-weight: 700; }
  .total { font-size: 12pt; font-weight: 700; }
  .change { font-size: 11pt; font-weight: 700; }
  .thanks { margin-top: 3mm; }
</style>
</head>
<body>
  <div class="center">
    <div class="shop">ANTU BOUTIQUE</div>
    <div class="muted">অনলাইন ও শোরুম ফ্যাশন বুটিক</div>
    <div class="muted">Showroom receipt</div>
  </div>
  <div class="rule"></div>
  ${row("Receipt", escapeHtml(order.orderNo))}
  ${row("Date", DHAKA_RECEIPT_TIME.format(order.createdAt))}
  ${row("Served by", escapeHtml(order.createdBy?.name ?? "—"))}
  ${row("Customer", customer)}
  <div class="rule"></div>
  ${items}
  <div class="rule"></div>
  ${row(`Subtotal (${itemCount} item${itemCount === 1 ? "" : "s"})`, formatBDT(order.subtotal))}
  ${toPaisa(order.discountTotal) > 0 ? row("Discount", `− ${formatBDT(order.discountTotal)}`) : ""}
  ${row("TOTAL", formatBDT(order.total), "total")}
  <div class="rule"></div>
  ${payments}
  ${change > 0 ? row("Change", formatBDT(fromPaisa(change)), "change") : ""}
  <div class="rule"></div>
  <div class="center thanks">
    <div>আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ!</div>
    <div>Thank you for shopping with us!</div>
  </div>
</body>
</html>`;
}

export async function renderReceiptPdf(order: ReceiptOrder): Promise<Uint8Array> {
  return renderHtmlToPdfFitHeight(renderReceiptHtml(order, await getFontFaceCss()), RECEIPT_PAPER_MM);
}
