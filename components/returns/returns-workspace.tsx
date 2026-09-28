"use client";

import { useEffect, useState } from "react";
import { Repeat2, Search, Store } from "lucide-react";

import { DateRangeFilter } from "@/components/list/date-range-filter";
import { ListPagination } from "@/components/list/list-pagination";
import { usePager } from "@/components/list/list-prefs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { CounterExchangeDialog } from "@/components/returns/counter-exchange-dialog";
import { ExchangeReportView } from "@/components/returns/exchange-report";
import { ChannelSelect, type ChannelFilterValue } from "@/components/orders/channel-select";
import { ReturnCaseCard, type CaseActions } from "@/components/returns/return-case-card";
import { dateRangeQuery, type DateRangeValue } from "@/lib/date-range";
import { ApiError, fetchJson } from "@/lib/orders/client";
import type { ReturnCaseTypeValue } from "@/lib/returns/constants";
import type { ReturnCaseView } from "@/lib/returns/types";

type Tab = "requested" | "approved" | "done" | "closed";
type ListResponse = { items: ReturnCaseView[]; total: number; counts: Record<Tab, number> };

const TABS: { key: Tab; label: string; empty: string }[] = [
  { key: "requested", label: "Awaiting approval", empty: "No requests waiting for approval." },
  { key: "approved", label: "Waiting for the item", empty: "Nothing on its way back." },
  { key: "done", label: "Completed", empty: "No completed returns or exchanges yet." },
  { key: "closed", label: "Rejected / cancelled", empty: "Nothing rejected or cancelled." },
];

// PRD §4.11 — every return and exchange the viewer's scope reaches, by
// where it stands, plus the exchange report. Approve/reject/cancel inline.
export function ReturnsWorkspace({
  permissions,
  initial = {},
}: {
  permissions: { canApproveReturn: boolean; canApproveExchange: boolean; canRequestReturn: boolean; canRequestExchange: boolean; canCounterExchange: boolean; seesBothTypes: boolean };
  /** From a dashboard link (P4.3). */
  initial?: { view?: Tab | "report"; type?: ReturnCaseTypeValue };
}) {
  const [view, setView] = useState<Tab | "report">(initial.view ?? (permissions.canApproveReturn || permissions.canApproveExchange ? "requested" : "approved"));
  const [type, setType] = useState<ReturnCaseTypeValue | "ALL">(initial.type ?? "ALL");
  const [channel, setChannel] = useState<ChannelFilterValue>("all");
  const [range, setRange] = useState<DateRangeValue>({ preset: "all" });
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const pager = usePager("returns");
  const { page, pageSize, setPage, reset } = pager;
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [counterOpen, setCounterOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(q.trim());
      reset();
    }, 300);
    return () => clearTimeout(t);
  }, [q, reset]);

  useEffect(() => {
    if (view === "report") return;
    const params = new URLSearchParams({ tab: view, page: String(page), pageSize: String(pageSize) });
    if (type !== "ALL") params.set("type", type);
    if (channel !== "all") params.set("channel", channel);
    if (query) params.set("q", query);
    for (const [k, v] of Object.entries(dateRangeQuery(range))) params.set(k, v);
    let live = true;
    fetchJson<ListResponse>(`/api/returns?${params}`)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Could not load returns and exchanges."));
    return () => {
      live = false;
    };
  }, [view, type, channel, range, query, page, pageSize, reloadKey]);

  const actions: CaseActions = {
    canApprove: (c) => (c.type === "EXCHANGE" ? permissions.canApproveExchange : permissions.canApproveReturn),
    canRequest: (c) => (c.type === "EXCHANGE" ? permissions.canRequestExchange : permissions.canRequestReturn),
  };
  const show = (next: Tab | "report") => {
    if (next === view) return;
    setData(null);
    pager.reset();
    setView(next);
  };
  const current = TABS.find((t) => t.key === view);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <Button key={t.key} size="sm" variant={view === t.key ? "default" : "outline"} onClick={() => show(t.key)}>
              {t.label}
              {data && data.counts[t.key] > 0 ? <Badge variant={view === t.key ? "secondary" : "outline"}>{data.counts[t.key]}</Badge> : null}
            </Button>
          ))}
          <Button size="sm" variant={view === "report" ? "default" : "outline"} onClick={() => show("report")}>
            Report
          </Button>
        </div>
        {permissions.canCounterExchange ? (
          <Button onClick={() => setCounterOpen(true)}>
            <Store />
            Exchange at counter
          </Button>
        ) : null}
      </div>

      {view === "report" ? (
        <ExchangeReportView />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <div className="relative min-w-0 flex-1 sm:max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-8" placeholder="Order no., customer, phone or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {permissions.seesBothTypes ? (
              <Select
                value={type}
                onValueChange={(v) => {
                  setType(v as ReturnCaseTypeValue | "ALL");
                  pager.reset();
                }}
              >
                <SelectTrigger className="w-40">
                  <SelectValue>{(v: string) => (v === "ALL" ? "All types" : v === "RETURN" ? "Returns only" : "Exchanges only")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All types</SelectItem>
                  <SelectItem value="RETURN">Returns only</SelectItem>
                  <SelectItem value="EXCHANGE">Exchanges only</SelectItem>
                </SelectContent>
              </Select>
            ) : null}
            <ChannelSelect
              value={channel}
              onChange={(v) => {
                setChannel(v);
                pager.reset();
              }}
            />
            <DateRangeFilter
              value={range}
              onChange={(v) => {
                setRange(v);
                pager.reset();
              }}
            />
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {!data ? (
            <div className="flex flex-col gap-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-32 w-full" />
              ))}
            </div>
          ) : data.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
              <Repeat2 className="size-8" />
              {query ? `Nothing matches “${query}”.` : current?.empty}
              {view === "requested" && !query ? <span>Returns and exchanges are asked for from the order screen.</span> : null}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {data.items.map((c) => (
                <ReturnCaseCard key={c.id} returnCase={c} actions={actions} onChanged={() => setReloadKey((k) => k + 1)} />
              ))}
            </div>
          )}

          {data && data.total > 0 ? <ListPagination page={page} pageSize={pageSize} total={data.total} onPageChange={setPage} onPageSizeChange={pager.setPageSize} /> : null}
        </>
      )}

      {counterOpen ? <CounterExchangeDialog onClose={() => setCounterOpen(false)} onDone={() => setReloadKey((k) => k + 1)} /> : null}
    </div>
  );
}
