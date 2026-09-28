"use client";

import { useEffect, useState } from "react";

import { DateRangeFilter } from "@/components/list/date-range-filter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dateRangeQuery, type DateRangeValue } from "@/lib/date-range";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { ORDER_CHANNEL_LABELS, type OrderChannelValue } from "@/lib/orders/constants";
import { RETURN_REASON_LABELS } from "@/lib/returns/constants";
import type { ExchangeReport } from "@/lib/returns/types";

// PRD §4.11 — exchanges and returns by reason, by product and variant, and
// by the executive who made the sale. "A product exchanged again and again
// is a sizing or photo problem." The courier charge we bore is shown only
// to roles that see cost (the API strips it otherwise).
export function ExchangeReportView() {
  const [range, setRange] = useState<DateRangeValue>({ preset: "this_month" });
  const [channel, setChannel] = useState<OrderChannelValue | "ALL">("ALL");
  const [data, setData] = useState<{ report: ExchangeReport; fromDay: string; toDay: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(dateRangeQuery(range, { bounded: true }));
    if (channel !== "ALL") params.set("channel", channel);
    let live = true;
    fetchJson<{ report: ExchangeReport; fromDay: string; toDay: string }>(`/api/returns/report?${params}`)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Could not load the report."));
    return () => {
      live = false;
    };
  }, [range, channel]);

  const r = data?.report;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="xr-range">Dates</Label>
          <DateRangeFilter id="xr-range" value={range} onChange={setRange} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Channel</Label>
          <Select value={channel} onValueChange={(v) => setChannel(v as OrderChannelValue | "ALL")}>
            <SelectTrigger className="w-36">
              <SelectValue>{(v: string) => (v === "ALL" ? "All channels" : ORDER_CHANNEL_LABELS[v as OrderChannelValue])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All channels</SelectItem>
              <SelectItem value="ONLINE">Online</SelectItem>
              <SelectItem value="WALK_IN">Walk-in</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {!r ? (
        <Skeleton className="h-48 w-full" />
      ) : r.totals.exchanges + r.totals.returns === 0 ? (
        <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">No returns or exchanges approved in this period.</p>
      ) : (
        <>
          <p className="text-sm">
            <b>{r.totals.exchanges}</b> exchange{r.totals.exchanges === 1 ? "" : "s"} ({r.totals.counter} at the counter) and <b>{r.totals.returns}</b> return{r.totals.returns === 1 ? "" : "s"} approved.{" "}
            {r.totals.companyBorne > 0 ? `We pay the courier on ${r.totals.companyBorne} exchange${r.totals.companyBorne === 1 ? "" : "s"}` : ""}
            {r.totals.companyBorne > 0 && r.totals.companyCourierCost !== undefined
              ? Number(r.totals.companyCourierCost) > 0
                ? ` — ${formatBDT(r.totals.companyCourierCost)} posted to Exchange / return cost so far.`
                : " — posted to Exchange / return cost once each parcel is final."
              : r.totals.companyBorne > 0
                ? "."
                : ""}
          </p>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">By reason</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reason</TableHead>
                      <TableHead className="text-right">Exchanges</TableHead>
                      <TableHead className="text-right">Returns</TableHead>
                      <TableHead className="text-right">Units</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.byReason.map((row) => (
                      <TableRow key={row.reason}>
                        <TableCell>{RETURN_REASON_LABELS[row.reason]}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.exchanges}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.returns}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.units}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">By sales executive</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Sold by</TableHead>
                      <TableHead className="text-right">Exchanges</TableHead>
                      <TableHead className="text-right">Returns</TableHead>
                      <TableHead className="text-right">Units</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.byStaff.map((row) => (
                      <TableRow key={row.name}>
                        <TableCell>{row.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.exchanges}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.returns}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.units}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">By product and variant</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product / variant</TableHead>
                    <TableHead className="text-right">Exchanged</TableHead>
                    <TableHead className="text-right">Returned</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.byProduct.flatMap((p) => [
                    <TableRow key={p.product} className="bg-muted/40 font-medium">
                      <TableCell>{p.product}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.exchangedUnits}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.returnedUnits}</TableCell>
                    </TableRow>,
                    ...p.variants.map((v) => (
                      <TableRow key={`${p.product}-${v.sku}`}>
                        <TableCell className="pl-6">
                          {v.label} <span className="font-mono text-xs text-muted-foreground">{v.sku}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{v.exchangedUnits}</TableCell>
                        <TableCell className="text-right tabular-nums">{v.returnedUnits}</TableCell>
                      </TableRow>
                    )),
                  ])}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
