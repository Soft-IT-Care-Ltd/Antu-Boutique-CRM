// Courier statement CSV → statement lines (PRD §4.9 "manual entry or CSV
// import"). Pure. Header names are matched loosely so a courier's own export
// can be pasted as-is; one of consignment id / order no. and the COD amount
// are required per row.

export type CsvStatementLine = {
  consignmentId: string | null;
  invoice: string | null;
  codAmount: number;
  deliveryCharge: number | null;
  codCharge: number | null;
};

const HEADERS = {
  consignmentId: ["consignment_id", "consignment id", "consignment", "cid", "tracking_id"],
  invoice: ["invoice", "order_no", "order no", "order", "order number", "merchant invoice", "invoice no"],
  codAmount: ["cod_amount", "cod amount", "cod", "collected", "collected amount", "amount"],
  deliveryCharge: ["delivery_charge", "delivery charge", "charge", "bill", "delivery fee"],
  codCharge: ["cod_charge", "cod charge", "cod fee", "cod_fee"],
} as const;

/** RFC-4180-ish: commas, "quoted, fields", doubled "" escapes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const money = (raw: string | undefined): number | null => {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw.replace(/[৳,\s]|tk|bdt/gi, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};

export function parseStatementCsv(text: string): { lines: CsvStatementLine[]; errors: string[] } {
  const rows = parseCsv(text);
  if (rows.length < 2) return { lines: [], errors: ["The CSV needs a header row and at least one line"] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (names: readonly string[]) => header.findIndex((h) => names.includes(h));
  const idx = {
    consignmentId: col(HEADERS.consignmentId),
    invoice: col(HEADERS.invoice),
    codAmount: col(HEADERS.codAmount),
    deliveryCharge: col(HEADERS.deliveryCharge),
    codCharge: col(HEADERS.codCharge),
  };
  const errors: string[] = [];
  if (idx.codAmount < 0) errors.push("No COD amount column (expected e.g. cod_amount, cod, collected)");
  if (idx.consignmentId < 0 && idx.invoice < 0) errors.push("No consignment id or order no. column");
  if (errors.length) return { lines: [], errors };

  const lines: CsvStatementLine[] = [];
  rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2;
    const cell = (j: number) => (j >= 0 ? (r[j] ?? "").trim() : "");
    const consignmentId = cell(idx.consignmentId) || null;
    const invoice = cell(idx.invoice) || null;
    const cod = money(cell(idx.codAmount));
    const deliveryCharge = idx.deliveryCharge >= 0 ? money(cell(idx.deliveryCharge)) : null;
    const codCharge = idx.codCharge >= 0 ? money(cell(idx.codCharge)) : null;
    if (!consignmentId && !invoice) return errors.push(`Row ${rowNo}: no consignment id or order no.`);
    if (cod == null || Number.isNaN(cod) || cod < 0) return errors.push(`Row ${rowNo}: COD amount "${cell(idx.codAmount)}" is not a number`);
    if (Number.isNaN(deliveryCharge) || Number.isNaN(codCharge)) return errors.push(`Row ${rowNo}: a charge is not a number`);
    lines.push({ consignmentId, invoice, codAmount: cod, deliveryCharge, codCharge });
  });
  return { lines, errors };
}
