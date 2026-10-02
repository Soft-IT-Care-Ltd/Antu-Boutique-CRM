import "server-only";

import { escapeHtml, formatPdfDate, getFontFaceCss, renderHtmlToPdf, SUB_ITEM_MARK } from "@/lib/pdf/render";
import { loadPackingOrder, serializePackingOrderDetail } from "@/lib/packing/queue";
import { BRAND_BLOCK_CSS, brandBlockHtml } from "@/lib/pdf/branding";
import { prisma } from "@/lib/prisma";
import { getDocumentBranding } from "@/lib/settings/business-profile";
import { DEFAULT_DOCUMENT_BRANDING, type DocumentBranding } from "@/lib/settings/business-profile-shape";
import { getPackingSlaHours } from "@/lib/settings/get";
import { readUploadedFile } from "@/lib/uploads/storage";
import type { PackingOrderDetail } from "@/lib/packing/types";

// PRD §4.8 packing slip: order no., customer name/phone/address, items with
// size + colour, qty, reference-image thumbnail, packer name, date. No
// price, no total, no payments — the packing slip is the one document
// Packing is explicitly allowed to see, and even it carries no money.

function extToMime(relativePath: string): string {
  const ext = relativePath.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

async function inlineThumbnail(relativePath: string): Promise<string | null> {
  try {
    const buffer = await readUploadedFile(relativePath);
    return `data:${extToMime(relativePath)};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function renderPackingSlipHtml(order: PackingOrderDetail, fontFaceCss: string, branding: DocumentBranding = DEFAULT_DOCUMENT_BRANDING): Promise<string> {
  const address = [order.customer.addressDetail, order.customer.thana, order.customer.district, order.customer.division]
    .filter(Boolean)
    .join(", ");

  // P3.3 (Gift Valy Round 2 §2.2) — an outfit set is never just its name:
  // every component is its own pick line, with its chosen size and colour.
  const itemRow = (item: PackingOrderDetail["items"][number]) => `
      <tr${item.set ? ' class="component"' : ""}>
        <td>${item.set ? SUB_ITEM_MARK : ""}${escapeHtml(item.productName)}<div class="muted">${escapeHtml(item.sku)}${shelfNote(item.shelves)}</div></td>
        <td><strong>${escapeHtml(item.sizeName)}</strong></td>
        <td><strong>${escapeHtml(item.colorName)}</strong></td>
        <td class="num">${item.qty}</td>
      </tr>`;
  const sets = [...new Map(order.items.filter((i) => i.set).map((i) => [i.set!.id, i.set!])).values()];
  const itemRows =
    order.items.filter((i) => !i.set).map(itemRow).join("") +
    sets
      .map((set) => `<tr><td colspan="4"><strong>${escapeHtml(set.name)}</strong> <span class="muted">× ${set.qty} — outfit set, pack every piece below</span></td></tr>${order.items.filter((i) => i.set?.id === set.id).map(itemRow).join("")}`)
      .join("");
  const packagingHtml = order.packaging.length
    ? `<div class="note"><h2>Packaging</h2><p>${order.packaging.map((p) => `${p.qty} × ${escapeHtml(p.label)}`).join(" · ")}</p></div>`
    : "";

  const thumbnails = await Promise.all(order.images.map((image) => inlineThumbnail(image.thumbPath)));
  const imagesHtml = thumbnails.some(Boolean)
    ? `<div class="box"><h2>Reference photos</h2><div class="thumbs">${thumbnails
        .filter((src): src is string => Boolean(src))
        .map((src) => `<img src="${src}" alt="" />`)
        .join("")}</div></div>`
    : "";

  return `<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8" />
<style>
  ${fontFaceCss}
  * { box-sizing: border-box; }
  body { font-family: 'Invoice Sans', sans-serif; font-size: 12px; color: #111; margin: 0; padding: 32px; }
  tr.component td:first-child { padding-left: 18px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 12px; margin-bottom: 16px; }
  .business { font-size: 20px; font-weight: 700; }
  .tag { color: #555; }
  .slip-title { text-align: right; }
  .slip-title h1 { font-size: 18px; margin: 0 0 4px; }
  .slip-title .order-no { color: #555; }
  .grid { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 20px; flex-wrap: wrap; }
  .box h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; margin: 0 0 6px; }
  .box p { margin: 0; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #555; border-bottom: 2px solid #111; }
  td.num, th.num { text-align: right; }
  .muted { color: #777; font-size: 10px; }
  .thumbs { display: flex; gap: 8px; flex-wrap: wrap; }
  .thumbs img { width: 90px; height: 90px; object-fit: cover; border-radius: 6px; border: 1px solid #ddd; }
  .note { border: 1px solid #ddd; border-radius: 6px; padding: 10px; margin-bottom: 20px; }
  .note h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; margin: 0 0 6px; }
  .checklist { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 20px; font-size: 11px; color: #333; }
  /* A tick drawn with borders: the embedded fonts have no tick glyph (P5.1). */
  .checklist span::before { content: ""; display: inline-block; width: 4px; height: 8px; margin: 0 7px 2px 2px; border: solid #146c2e; border-width: 0 2px 2px 0; transform: rotate(45deg); }
  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #ddd; color: #555; font-size: 10px; display: flex; justify-content: space-between; }
  ${BRAND_BLOCK_CSS}
</style>
</head>
<body>
  <div class="header">
    <div class="business">${brandBlockHtml(branding, { contact: false })}</div>
    <div class="slip-title">
      <h1>Packing Slip</h1>
      <div class="order-no">${escapeHtml(order.orderNo)}</div>
    </div>
  </div>

  <div class="grid">
    <div class="box">
      <h2>Deliver to</h2>
      <p><strong>${escapeHtml(order.customer.name)}</strong></p>
      <p>${escapeHtml(order.customer.phone)}</p>
      <p>${escapeHtml(address || "—")}</p>
    </div>
    ${imagesHtml}
  </div>

  <table>
    <thead>
      <tr>
        <th>Item</th>
        <th>Size</th>
        <th>Colour</th>
        <th class="num">Qty</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
    </tbody>
  </table>

  ${packagingHtml}
  ${order.internalNote ? `<div class="note"><h2>Internal note</h2><p>${escapeHtml(order.internalNote)}</p></div>` : ""}

  <div class="checklist">
    <span>Items match</span>
    <span>Image matched</span>
    <span>Quality checked</span>
    <span>Invoice printed</span>
  </div>

  <div class="footer">
    <span>Packed by: ${escapeHtml(order.packedBy?.name ?? "—")}</span>
    <span>Date: ${order.packedAt ? formatPdfDate(order.packedAt) : "—"}</span>
  </div>
</body>
</html>`;
}

/** Renders the packing slip PDF fresh from the order's current state — not persisted, safe to regenerate on every print. */
export async function generatePackingSlipPdf(orderId: string): Promise<Uint8Array> {
  const loaded = await loadPackingOrder(orderId);
  if (!loaded) throw new Error(`Order ${orderId} not found`);

  const slaHours = await getPackingSlaHours();
  const order = serializePackingOrderDetail(loaded, slaHours);

  const [fontFaceCss, branding] = await Promise.all([getFontFaceCss(), getDocumentBranding(prisma)]);
  const html = await renderPackingSlipHtml(order, fontFaceCss, branding);
  return renderHtmlToPdf(html);
}

/** C4b — "Shelf A-2-3 ×2, B-1 · 1 unassigned" on the slip's pick line (CORRECTIONS.md item 20A). */
function shelfNote(spots: PackingOrderDetail["items"][number]["shelves"]): string {
  if (!spots || (spots.shelves.length === 0 && spots.unassigned <= 0)) return "";
  const parts = spots.shelves.map((s) => `<strong>${escapeHtml(s.code)}</strong>${s.qty > 1 ? ` ×${s.qty}` : ""}`);
  if (spots.unassigned > 0) parts.push(`${spots.unassigned} unassigned`);
  return ` · Shelf ${parts.join(", ")}`;
}
