"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Download } from "lucide-react";

import { DateRangeFilter } from "@/components/list/date-range-filter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dateRangeQuery, type DateRangeValue } from "@/lib/date-range";
import { LEAD_LOST_REASON_LABELS, LEAD_SOURCE_LABELS, LEAD_SOURCE_VALUES, type LeadSourceValue } from "@/lib/leads/constants";
import type { ConversionRow, LeadConversionReport, LeadPerson } from "@/lib/leads/types";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";

const pct = (rate: number | null) => (rate === null ? "—" : `${(rate * 100).toFixed(rate > 0 && rate < 0.1 ? 1 : 0)}%`);

/**
 * PRD §4.5 conversion rate per executive, source and campaign. A cohort:
 * leads that came in during the period, and how many have bought since.
 */
export function ConversionReportView({ people, canExport }: { people: LeadPerson[]; canExport: boolean }) {
  const [range, setRange] = useState<DateRangeValue>({ preset: "this_month" });
  const [ownerId, setOwnerId] = useState("all");
  const [source, setSource] = useState<LeadSourceValue | "all">("all");
  const [report, setReport] = useState<LeadConversionReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const params = new URLSearchParams(dateRangeQuery(range, { bounded: true }));
  if (ownerId !== "all") params.set("ownerId", ownerId);
  if (source !== "all") params.set("source", source);
  const query = params.toString();

  useEffect(() => {
    let live = true;
    fetchJson<{ report: LeadConversionReport }>(`/api/leads/report?${query}`)
      .then((d) => {
        if (!live) return;
        setReport(d.report);
        setError(null);
      })
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Could not load the report."));
    return () => {
      live = false;
    };
  }, [query]);

  const t = report?.totals;
  // Rows link to the lead list with the same cut applied.
  const leadLink = (extra: Record<string, string>) => `/leads?${new URLSearchParams({ status: "all", ...(ownerId !== "all" ? { ownerId } : {}), ...(source !== "all" ? { source } : {}), ...extra })}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
        <DateRangeFilter value={range} onChange={setRange} />
        {people.length > 1 ? (
          <Select value={ownerId} onValueChange={(v) => setOwnerId(v as string)}>
            <SelectTrigger className="w-full sm:w-48" aria-label="Sales executive">
              <SelectValue>{(v: string) => (v === "all" ? "Everyone" : (people.find((p) => p.id === v)?.name ?? "Everyone"))}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Everyone</SelectItem>
              {people.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Select value={source} onValueChange={(v) => setSource(v as LeadSourceValue | "all")}>
          <SelectTrigger className="w-full sm:w-44" aria-label="Source">
            <SelectValue>{(v: string) => (v === "all" ? "All sources" : LEAD_SOURCE_LABELS[v as LeadSourceValue])}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {LEAD_SOURCE_VALUES.map((s) => (
              <SelectItem key={s} value={s}>
                {LEAD_SOURCE_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canExport ? (
          <Button variant="outline" className="sm:ml-auto" render={<a href={`/api/leads/report?${query}&format=csv`} download />} nativeButton={false}>
            <Download />
            CSV
          </Button>
        ) : null}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!report || !t ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-48 w-full" />
        </div>
      ) : t.leads === 0 ? (
        <div className="rounded-lg border border-dashed py-16 text-center text-sm text-muted-foreground">No leads came in during this period.</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Conversion rate" value={pct(t.rate)} sub={`${t.converted} of ${t.leads} leads bought`} />
            <Stat label="Leads" value={String(t.leads)} sub={t.counted > 0 ? `${t.recorded} recorded · ${t.counted} counted` : "all recorded one by one"} />
            <Stat label="Still open" value={String(t.open)} sub={`${t.lost} lost`} />
            <Stat label="Converted order value" value={formatBDT(t.convertedValue)} sub="recorded leads, cancelled orders excluded" />
          </div>

          <Breakdown title="By sales executive" rows={report.bySe} linkFor={(r) => (r.key.startsWith("__") ? null : leadLink({ ownerId: r.key }))} />
          <Breakdown title="By source" rows={report.bySource} linkFor={(r) => leadLink({ source: r.key })} />
          <Breakdown title="By campaign" rows={report.byCampaign} linkFor={(r) => (r.key.startsWith("__") ? null : leadLink({ campaign: r.label }))} />

          {report.lostReasons.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Why leads were lost</CardTitle>
                <CardDescription>Recorded leads marked lost in this period&apos;s cohort.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {report.lostReasons.map((r) => (
                  <div key={r.reason} className="grid grid-cols-[9rem_1fr_2.5rem] items-center gap-3 text-sm">
                    <span>{LEAD_LOST_REASON_LABELS[r.reason]}</span>
                    <Meter value={r.count / t.lost} />
                    <span className="text-right tabular-nums">{r.count}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          <p className="text-xs text-muted-foreground">
            Leads that came in between {report.fromDay} and {report.toDay} — recorded ones by the day they were added, counted ones by the day counted — and how many have
            bought since. Open and lost apply to recorded leads only.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-0.5">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        <span className="text-xs text-muted-foreground">{sub}</span>
      </CardContent>
    </Card>
  );
}

/** A single-series bar for a 0–1 share; the number is always printed beside it. */
function Meter({ value }: { value: number | null }) {
  const width = value === null ? 0 : Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="h-2 w-full rounded-full bg-muted" aria-hidden>
      <div className="h-2 rounded-full bg-primary" style={{ width: `${width}%`, minWidth: width > 0 ? 4 : 0 }} />
    </div>
  );
}

function Breakdown({ title, rows, linkFor }: { title: string; rows: ConversionRow[]; linkFor: (row: ConversionRow) => string | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">Bought</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Lost</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Open</TableHead>
                <TableHead className="w-40">Conversion</TableHead>
                <TableHead className="hidden text-right md:table-cell">Order value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const href = linkFor(r);
                return (
                  <TableRow key={r.key}>
                    <TableCell className="font-medium">
                      {href ? (
                        <Link href={href} className="underline-offset-4 hover:underline">
                          {r.label}
                        </Link>
                      ) : (
                        r.label
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.leads}
                      {r.counted > 0 ? <span className="block text-xs text-muted-foreground">{r.counted} counted</span> : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.converted}</TableCell>
                    <TableCell className="hidden text-right tabular-nums sm:table-cell">{r.lost}</TableCell>
                    <TableCell className="hidden text-right tabular-nums sm:table-cell">{r.open}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Meter value={r.rate} />
                        <span className="w-11 shrink-0 text-right text-sm tabular-nums">{pct(r.rate)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums md:table-cell">{formatBDT(r.convertedValue)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
