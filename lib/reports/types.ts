// P4.4 (PRD §4.15) — the one shape every report R1–R14 and the P&L come
// back in, so the screen, the CSV and the PDF are always the same numbers.
// Client- and server-safe.
//
// Money is a taka string ("1234.50", summed in paisa), a percent is a
// ratio (0.25 = 25%), a day is YYYY-MM-DD. Row keys starting with "_" are
// not columns (`_href` links the row's first cell).

export type ReportCell = string | number | null;
export type ReportRow = Record<string, ReportCell>;

export type CellFormat = "text" | "int" | "money" | "percent" | "day" | "decimal";

export type ReportColumn = {
  key: string;
  label: string;
  format?: CellFormat;
  /**
   * Cost, profit, margin or purchase price (CLAUDE.md rule 5): removed —
   * definition and every value — before the report leaves the server for
   * anyone without product.cost.view (lib/reports/finalize.ts).
   */
  costOnly?: boolean;
};

export type ReportTable = {
  id: string;
  title: string;
  description?: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** A totals line under the rows, keyed like a row. */
  totals?: ReportRow;
  /** Shown when there are no rows. */
  empty?: string;
};

export type ReportFigure = {
  label: string;
  value: ReportCell;
  format: CellFormat;
  hint?: string;
  href?: string;
  /** Negative money is shown in red (a loss). */
  signed?: boolean;
  costOnly?: boolean;
};

export type ReportResult = {
  key: string;
  code: string;
  title: string;
  /** Inclusive Dhaka days; null for a report that is a snapshot of now. */
  period: { fromDay: string; toDay: string } | null;
  /** Human-readable filters applied, for the export header. */
  applied: { label: string; value: string }[];
  figures: ReportFigure[];
  tables: ReportTable[];
  notes: string[];
  generatedAt: string;
};
