import "server-only";

import { escapeHtml, getFontFaceCss, renderHtmlToPdf } from "@/lib/pdf/render";
import { formatCell, formatPeriod, isNegative } from "@/lib/reports/format";
import type { CellFormat, ReportCell, ReportColumn, ReportResult, ReportRow } from "@/lib/reports/types";

// CSV and PDF from a finished (already scoped and cost-stripped)
// ReportResult — an export can only ever contain what the screen shows.

const DHAKA_STAMP = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });

export function reportFileName(r: ReportResult, ext: "csv" | "pdf"): string {
  const slug = r.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const period = r.period ? `${r.period.fromDay}_to_${r.period.toDay}` : r.generatedAt.slice(0, 10);
  return `${r.code}-${slug}-${period}.${ext}`;
}

// ---------------------------------------------------------------------------
// CSV — numbers stay numbers (money in taka with 2 decimals, percents as
// 12.5), so the sheet can be summed. UTF-8 with a BOM so Excel shows Bangla.
// ---------------------------------------------------------------------------

function csvValue(value: ReportCell, format: CellFormat = "text"): string {
  if (value === null) return "";
  if (format === "percent") return (Number(value) * 100).toFixed(1);
  if (format === "money") return Number(value).toFixed(2);
  let s = String(value);
  // A text cell starting with = + - @ would run as a formula in a spreadsheet.
  if ((format === "text" || format === "day") && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvHeader = (c: ReportColumn) => csvValue(c.format === "percent" ? `${c.label} (%)` : c.format === "money" ? `${c.label} (BDT)` : c.label);

export function reportToCsv(r: ReportResult): string {
  const lines: string[] = [];
  const line = (...cells: string[]) => lines.push(cells.join(","));
  line(csvValue(`Antu Boutique — ${r.code} ${r.title}`));
  line(csvValue("Period"), csvValue(formatPeriod(r.period)));
  for (const a of r.applied) line(csvValue(a.label), csvValue(a.value));
  line(csvValue("Generated"), csvValue(DHAKA_STAMP.format(new Date(r.generatedAt))));
  if (r.figures.length) {
    lines.push("");
    for (const f of r.figures) line(csvValue(f.label), csvValue(f.value, f.format));
  }
  for (const t of r.tables) {
    lines.push("", csvValue(t.title));
    line(...t.columns.map(csvHeader));
    const row = (x: ReportRow) => line(...t.columns.map((c) => csvValue(x[c.key] ?? null, c.format)));
    t.rows.forEach(row);
    if (t.totals) row(t.totals);
  }
  if (r.notes.length) {
    lines.push("");
    for (const n of r.notes) line(csvValue(n));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// PDF — A4 (landscape when a table is wide), Bangla font embedded.
// ---------------------------------------------------------------------------

function cellHtml(value: ReportCell, format: CellFormat | undefined, signed = false): string {
  const text = escapeHtml(formatCell(value, format));
  return signed && isNegative(value) ? `<span class="neg">${text}</span>` : text;
}

const isNumeric = (f?: CellFormat) => f !== undefined && f !== "text" && f !== "day";

export async function renderReportHtml(r: ReportResult): Promise<string> {
  const fontFaceCss = await getFontFaceCss();
  const figures = r.figures
    .map((f) => `<div class="fig"><div class="lbl">${escapeHtml(f.label)}</div><div class="val">${cellHtml(f.value, f.format, f.signed)}</div>${f.hint ? `<div class="hint">${escapeHtml(f.hint)}</div>` : ""}</div>`)
    .join("");
  const tables = r.tables
    .map((t) => {
      const head = t.columns.map((c) => `<th class="${isNumeric(c.format) ? "num" : ""}">${escapeHtml(c.label)}</th>`).join("");
      const row = (x: ReportRow, cls = "") => `<tr class="${cls}${x._strong ? " strong" : ""}">${t.columns.map((c) => `<td class="${isNumeric(c.format) ? "num" : ""}">${c.key in x ? cellHtml(x[c.key], c.format, c.format === "money") : ""}</td>`).join("")}</tr>`;
      const body = t.rows.length ? t.rows.map((x) => row(x)).join("") : `<tr><td colspan="${t.columns.length}" class="empty">${escapeHtml(t.empty ?? "Nothing to show.")}</td></tr>`;
      return `<section><h2>${escapeHtml(t.title)}</h2>${t.description ? `<p class="desc">${escapeHtml(t.description)}</p>` : ""}<table><thead><tr>${head}</tr></thead><tbody>${body}${t.totals ? row(t.totals, "total") : ""}</tbody></table></section>`;
    })
    .join("");
  const applied = r.applied.map((a) => `${escapeHtml(a.label)}: ${escapeHtml(a.value)}`).join(" · ");

  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaceCss}
* { box-sizing: border-box; }
body { font-family: 'Invoice Sans', sans-serif; color: #111; font-size: 8.5pt; margin: 0; }
header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 1.5px solid #111; padding-bottom: 6px; margin-bottom: 10px; }
h1 { font-size: 14pt; margin: 0; }
.sub { color: #555; font-size: 8.5pt; margin-top: 2px; }
.figs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.fig { border: 1px solid #ccc; border-radius: 4px; padding: 5px 8px; min-width: 110px; }
.fig .lbl { color: #555; font-size: 7.5pt; }
.fig .val { font-size: 11pt; font-weight: 700; }
.fig .hint { color: #777; font-size: 7pt; }
section { margin-bottom: 12px; }
h2 { font-size: 10pt; margin: 0 0 3px; break-after: avoid; }
.desc { color: #555; margin: 0 0 4px; }
table { width: 100%; border-collapse: collapse; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th { text-align: left; font-weight: 700; border-bottom: 1px solid #111; padding: 3px 4px; background: #f2f2f2; }
td { border-bottom: 1px solid #e3e3e3; padding: 2.5px 4px; vertical-align: top; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
tr.total td { border-top: 1px solid #111; font-weight: 700; }
tr.strong td { font-weight: 700; }
.neg { color: #b91c1c; }
.empty { color: #777; text-align: center; padding: 8px; }
.notes { color: #555; font-size: 7.5pt; margin-top: 8px; }
.notes p { margin: 0 0 3px; }
</style></head><body>
<header><div><h1>${escapeHtml(`${r.code} · ${r.title}`)}</h1><div class="sub">${escapeHtml(formatPeriod(r.period))}${applied ? ` · ${applied}` : ""}</div></div>
<div class="sub" style="text-align:right"><strong>Antu Boutique</strong><br>Generated ${escapeHtml(DHAKA_STAMP.format(new Date(r.generatedAt)))}</div></header>
${figures ? `<div class="figs">${figures}</div>` : ""}
${tables}
${r.notes.length ? `<div class="notes">${r.notes.map((n) => `<p>${escapeHtml(n)}</p>`).join("")}</div>` : ""}
</body></html>`;
}

export async function reportToPdf(r: ReportResult): Promise<Uint8Array> {
  const wide = r.tables.some((t) => t.columns.length > 7);
  return renderHtmlToPdf(await renderReportHtml(r), undefined, { landscape: wide, marginMm: 10 });
}
