// P5.2 opening-data import — a small RFC 4180 CSV reader, so a sheet saved
// from Excel or Google Sheets ("CSV UTF-8") reads back exactly: quoted
// fields, commas and line breaks inside quotes, doubled quotes, CRLF, and
// the byte-order mark Excel puts in front. Pure; no server-only.

export type CsvTable = { headers: string[]; rows: { line: number; values: Record<string, string> }[] };

export class CsvError extends Error {}

/** "Opening Qty", "opening-qty" and "opening_qty" are one column. */
export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s\-/]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function parseRecords(text: string): { line: number; fields: string[] }[] {
  const records: { line: number; fields: string[] }[] = [];
  let field = "";
  let fields: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") inQuotes = true;
    else if (ch === ",") {
      fields.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      fields.push(field);
      records.push({ line: recordLine, fields });
      fields = [];
      field = "";
      line++;
      recordLine = line;
    } else field += ch;
  }
  if (inQuotes) throw new CsvError(`A quoted value starting on line ${recordLine} is never closed`);
  if (field !== "" || fields.length > 0) {
    fields.push(field);
    records.push({ line: recordLine, fields });
  }
  return records;
}

/** Headers normalised; blank lines dropped; every value trimmed. `line` is the sheet row, header = 1. */
export function parseCsv(text: string, { maxRows = 5000 }: { maxRows?: number } = {}): CsvTable {
  const records = parseRecords(text.replace(/^﻿/, "")).filter((r) => r.fields.some((f) => f.trim() !== ""));
  if (records.length === 0) throw new CsvError("The file is empty");
  const headers = records[0].fields.map(normalizeHeader);
  const seen = new Set<string>();
  for (const h of headers) {
    if (!h) continue;
    if (seen.has(h)) throw new CsvError(`The column "${h}" appears twice`);
    seen.add(h);
  }
  const body = records.slice(1);
  if (body.length === 0) throw new CsvError("The file has a header row but no data");
  if (body.length > maxRows) throw new CsvError(`At most ${maxRows} rows per file — split it into smaller files`);
  return {
    headers,
    rows: body.map((r) => ({
      line: r.line,
      values: Object.fromEntries(headers.map((h, i) => [h, (r.fields[i] ?? "").trim()]).filter(([h]) => h)),
    })),
  };
}

/** Writes rows as CSV (for the templates), with a BOM so Excel opens Bangla as UTF-8. */
export function toCsv(headers: string[], rows: string[][]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return "﻿" + [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
