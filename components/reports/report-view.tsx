import Link from "next/link";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCell, isNegative } from "@/lib/reports/format";
import type { CellFormat, ReportFigure, ReportResult, ReportTable } from "@/lib/reports/types";
import { cn } from "@/lib/utils";

// P4.4 — renders any ReportResult (R1–R14, P&L). Server component: the
// numbers arrive already scoped and cost-stripped (lib/reports/run.ts).

/** On screen a table stops here; the export carries every row. */
const SCREEN_ROWS = 300;

const numeric = (f?: CellFormat) => f !== undefined && f !== "text" && f !== "day";

export function ReportView({ report }: { report: ReportResult }) {
  return (
    <div className="flex flex-col gap-4">
      {report.figures.length ? (
        <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 xl:grid-cols-6">
          {report.figures.map((f) => (
            <Figure key={f.label} figure={f} />
          ))}
        </div>
      ) : null}
      {report.tables.map((t) => (
        <ReportTableCard key={t.id} table={t} />
      ))}
      {report.notes.length ? (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          {report.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Figure({ figure: f }: { figure: ReportFigure }) {
  const body = (
    <>
      <p className="text-xs font-medium text-muted-foreground sm:text-sm">{f.label}</p>
      <p className={cn("truncate text-lg font-semibold tabular-nums sm:text-xl", f.signed && isNegative(f.value) && "text-destructive")}>{formatCell(f.value, f.format)}</p>
      {f.hint ? <p className="truncate text-xs text-muted-foreground">{f.hint}</p> : null}
    </>
  );
  return f.href ? (
    <Link href={f.href} className="rounded-xl border bg-card p-3 transition-colors hover:bg-muted/40 sm:p-4">
      {body}
    </Link>
  ) : (
    <div className="rounded-xl border bg-card p-3 sm:p-4">{body}</div>
  );
}

function ReportTableCard({ table: t }: { table: ReportTable }) {
  const rows = t.rows.slice(0, SCREEN_ROWS);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.title}</CardTitle>
        {t.description ? <CardDescription>{t.description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        {t.rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t.empty ?? "Nothing to show."}</p>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  {t.columns.map((c) => (
                    <TableHead key={c.key} className={cn(numeric(c.format) && "text-right")}>
                      {c.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={i} className={cn(r._strong ? "font-semibold" : undefined)}>
                    {t.columns.map((c, j) => {
                      const text = formatCell(r[c.key] ?? null, c.format);
                      const href = j === 0 && typeof r._href === "string" ? r._href : null;
                      return (
                        <TableCell key={c.key} className={cn(numeric(c.format) && "text-right tabular-nums", c.format === "money" && isNegative(r[c.key] ?? null) && "text-destructive", j === 0 && "whitespace-pre font-medium")}>
                          {href ? (
                            <Link href={href} className="hover:underline">
                              {text}
                            </Link>
                          ) : (
                            text
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
              {t.totals ? (
                <TableFooter>
                  <TableRow>
                    {t.columns.map((c) => (
                      <TableCell key={c.key} className={cn("font-semibold", numeric(c.format) && "text-right tabular-nums")}>
                        {c.key in t.totals! ? formatCell(t.totals![c.key], c.format) : ""}
                      </TableCell>
                    ))}
                  </TableRow>
                </TableFooter>
              ) : null}
            </Table>
          </div>
        )}
        {t.rows.length > SCREEN_ROWS ? <p className="pt-2 text-sm text-muted-foreground">Showing the first {SCREEN_ROWS} of {t.rows.length} rows — the totals and the export include them all.</p> : null}
      </CardContent>
    </Card>
  );
}
