"use client";

import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IMPORT_COLUMNS, type ImportKind, type ImportReport } from "@/lib/import/types";
import { cn } from "@/lib/utils";

const KIND_TEXT: Record<ImportKind, { tab: string; title: string; intro: string }> = {
  products: {
    tab: "Products",
    title: "Products & opening stock",
    intro: "One row per size/colour. Sizes, colours and categories must already be in Catalog masters. Opening stock is posted to the stock ledger at the unit cost you give, which becomes each variant's average cost.",
  },
  customers: {
    tab: "Customers",
    title: "Customers",
    intro: "One row per person. A phone already in the system is skipped, never overwritten — so you can fix a few rows and upload the same sheet again. Add staff first if you fill owner_phone.",
  },
  wallets: {
    tab: "Wallets",
    title: "Wallet opening balances",
    intro: "What each wallet held on the day it was counted. A name that matches an existing wallet updates its opening balance and date; a new name adds a wallet.",
  },
};

type Props = { canProducts: boolean; canCustomers: boolean; canWallets: boolean };

// P5.2 go-live — real opening data from a spreadsheet. Check first: the
// whole sheet is checked and every problem listed by row; nothing is written
// until the sheet is clean and you press Import. All or nothing.
export function ImportSettings({ canProducts, canCustomers, canWallets }: Props) {
  const kinds = ([canProducts && "products", canCustomers && "customers", canWallets && "wallets"].filter(Boolean) as ImportKind[]);
  if (kinds.length === 0) return <p className="text-sm text-muted-foreground">You don&apos;t have the permissions an import needs.</p>;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Before you start</CardTitle>
          <CardDescription>
            Fill in the masters and staff first, then import in this order: products, customers, wallets. Save sheets from Excel as <strong>CSV UTF-8</strong> (or Google Sheets → Download → CSV) so Bangla survives. Dates are YYYY-MM-DD or DD/MM/YYYY. Lists inside one cell use semicolons.
          </CardDescription>
        </CardHeader>
      </Card>
      <Tabs defaultValue={kinds[0]}>
        <TabsList>
          {kinds.map((k) => (
            <TabsTrigger key={k} value={k}>
              {KIND_TEXT[k].tab}
            </TabsTrigger>
          ))}
        </TabsList>
        {kinds.map((k) => (
          <TabsContent key={k} value={k} className="pt-4">
            <ImportPanel kind={k} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function ImportPanel({ kind }: { kind: ImportKind }) {
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function send(mode: "preview" | "commit", f: File) {
    setBusy(mode);
    setError(null);
    try {
      const body = new FormData();
      body.append("mode", mode);
      body.append("file", f);
      const res = await fetch(`/api/settings/import/${kind}`, { method: "POST", body });
      const json = (await res.json().catch(() => ({}))) as { report?: ImportReport; error?: string };
      if (json.report) setReport(json.report);
      else setError(json.error ?? `Request failed (${res.status})`);
    } catch {
      setError("Couldn't reach the server — check the connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  function choose(f: File | null | undefined) {
    if (!f) return;
    setFile(f);
    setReport(null);
    void send("preview", f);
  }

  const columns = IMPORT_COLUMNS[kind];
  const canCommit = report && !report.committed && report.errors.length === 0 && report.rows > 0;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{KIND_TEXT[kind].title}</CardTitle>
          <CardDescription>{KIND_TEXT[kind].intro}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <details className="rounded-md border px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium">Columns ({columns.length})</summary>
            <dl className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-[max-content_1fr]">
              {columns.map((c) => (
                <div key={c.name} className="contents">
                  <dt className="font-mono text-xs">
                    {c.name}
                    {c.required ? <span className="text-destructive"> *</span> : null}
                  </dt>
                  <dd className="text-muted-foreground">{c.note || "—"}</dd>
                </div>
              ))}
            </dl>
          </details>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              choose(e.dataTransfer.files?.[0]);
            }}
            className={cn("flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-6 text-center transition-colors", dragging ? "border-primary bg-primary/5" : "border-muted-foreground/25")}
          >
            <FileSpreadsheet className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{file ? file.name : "Drop a CSV here, or choose one."}</p>
            <input ref={inputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => choose(e.target.files?.[0])} />
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} disabled={busy !== null}>
                <Upload />
                {file ? "Choose another file" : "Choose file"}
              </Button>
              {file && !report?.committed ? (
                <Button size="sm" variant="ghost" onClick={() => send("preview", file)} disabled={busy !== null}>
                  {busy === "preview" ? <Loader2 className="animate-spin" /> : null}
                  Check again
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" render={<a href={`/api/settings/import/${kind}/template`} download />} nativeButton={false}>
                <Download />
                Template
              </Button>
            </div>
          </div>
          {busy === "preview" ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Checking every row…
            </p>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>

      {report ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {report.committed ? (
                <>
                  <CheckCircle2 className="size-5 text-emerald-600" /> Imported
                </>
              ) : report.errors.length > 0 ? (
                <>
                  <XCircle className="size-5 text-destructive" /> {report.errors.length} problem{report.errors.length === 1 ? "" : "s"} to fix
                </>
              ) : (
                <>
                  <CheckCircle2 className="size-5 text-emerald-600" /> Ready to import
                </>
              )}
            </CardTitle>
            <CardDescription>
              {report.rows} row{report.rows === 1 ? "" : "s"} read.{" "}
              {report.committed ? "Everything below was written, and the audit log has a record of it." : report.errors.length > 0 ? "Nothing has been written. Fix these rows in the sheet and choose it again." : "Nothing has been written yet."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {report.summary.length > 0 ? (
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {report.summary.map((s) => (
                  <div key={s.label} className="rounded-md border p-2">
                    <dt className="text-xs text-muted-foreground">{s.label}</dt>
                    <dd className="text-lg font-semibold tabular-nums">{s.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}

            {report.errors.length > 0 ? <IssueList tone="error" issues={report.errors} /> : null}
            {report.warnings.length > 0 ? <IssueList tone="warning" issues={report.warnings} /> : null}

            {report.preview.length > 0 && report.errors.length === 0 ? (
              <details open={report.preview.length <= 20} className="rounded-md border px-3 py-2 text-sm">
                <summary className="cursor-pointer font-medium">
                  {report.committed ? "What was imported" : "What will be imported"} ({report.preview.length}
                  {report.preview.length >= 200 ? "+" : ""})
                </summary>
                <ul className="mt-2 flex flex-col gap-1">
                  {report.preview.map((p) => (
                    <li key={`${p.line}-${p.text}`} className="flex gap-2">
                      <span className="w-12 shrink-0 text-right font-mono text-xs text-muted-foreground">row {p.line}</span>
                      <span className="min-w-0 break-words">{p.text}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            {canCommit ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => file && send("commit", file)} disabled={busy !== null}>
                  {busy === "commit" ? <Loader2 className="animate-spin" /> : null}
                  Import {report.rows} row{report.rows === 1 ? "" : "s"}
                </Button>
                <span className="text-xs text-muted-foreground">All or nothing — if anything changed since this check, nothing is written and you&apos;ll see why.</span>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function IssueList({ tone, issues }: { tone: "error" | "warning"; issues: ImportReport["errors"] }) {
  const shown = issues.slice(0, 100);
  return (
    <div className={cn("rounded-md border p-3", tone === "error" ? "border-destructive/40 bg-destructive/5" : "border-amber-500/40 bg-amber-500/5")}>
      <p className="mb-2 flex items-center gap-2 text-sm font-medium">
        {tone === "error" ? <XCircle className="size-4 text-destructive" /> : <AlertTriangle className="size-4 text-amber-600" />}
        {tone === "error" ? "Fix before importing" : "Worth a look"}
        <Badge variant="outline">{issues.length}</Badge>
      </p>
      <ul className="flex flex-col gap-1 text-sm">
        {shown.map((i, n) => (
          <li key={n} className="flex gap-2">
            <span className="w-12 shrink-0 text-right font-mono text-xs text-muted-foreground">{i.line ? `row ${i.line}` : "file"}</span>
            <span className="min-w-0 break-words">{i.message}</span>
          </li>
        ))}
      </ul>
      {issues.length > shown.length ? <p className="mt-2 text-xs text-muted-foreground">…and {issues.length - shown.length} more.</p> : null}
    </div>
  );
}
