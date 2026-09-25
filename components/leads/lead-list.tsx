"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Search, Users2 } from "lucide-react";

import { FollowUpTime, LeadStatusBadge } from "@/components/leads/lead-badges";
import { LeadFormDialog } from "@/components/leads/lead-form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  LEAD_FOLLOW_UP_FILTERS,
  LEAD_LOST_REASON_LABELS,
  LEAD_SOURCE_LABELS,
  LEAD_SOURCE_VALUES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_VALUES,
  isOpenLeadStatus,
  OPEN_LEAD_STATUSES,
  type LeadFollowUpFilter,
  type LeadSourceValue,
  type LeadStatusValue,
} from "@/lib/leads/constants";
import type { LeadListItem, LeadPerson, LeadStatusCounts } from "@/lib/leads/types";
import { ApiError, fetchJson } from "@/lib/orders/client";

const PAGE_SIZE = 20;

type StatusFilter = LeadStatusValue | "open" | "all";

const FOLLOW_UP_LABELS: Record<LeadFollowUpFilter, string> = {
  overdue: "Overdue",
  today: "Due later today",
  upcoming: "Upcoming",
  none: "No follow-up set",
};

type ListResponse = { items: LeadListItem[]; total: number; counts: LeadStatusCounts };

export type LeadListInitialFilters = { status?: StatusFilter; source?: LeadSourceValue; followUp?: LeadFollowUpFilter; ownerId?: string; campaign?: string };

export function LeadList({
  canCreate,
  people,
  campaigns,
  initialFilters,
}: {
  canCreate: boolean;
  /** Executives in scope — the owner filter shows only when there's more than one. */
  people: LeadPerson[];
  campaigns: string[];
  initialFilters: LeadListInitialFilters;
}) {
  const router = useRouter();
  const [data, setData] = useState<ListResponse | null>(null);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>(initialFilters.status ?? "open");
  const [source, setSource] = useState<LeadSourceValue | "all">(initialFilters.source ?? "all");
  const [followUp, setFollowUp] = useState<LeadFollowUpFilter | "all">(initialFilters.followUp ?? "all");
  const [ownerId, setOwnerId] = useState<string>(initialFilters.ownerId ?? "all");
  const [campaign, setCampaign] = useState<string>(initialFilters.campaign ?? "");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(q.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (query) params.set("q", query);
    if (status !== "all") params.set("status", status);
    if (source !== "all") params.set("source", source);
    if (followUp !== "all") params.set("followUp", followUp);
    if (ownerId !== "all") params.set("ownerId", ownerId);
    if (campaign) params.set("campaign", campaign);
    let live = true;
    fetchJson<ListResponse>(`/api/leads?${params}`)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Could not load leads."));
    return () => {
      live = false;
    };
  }, [query, status, source, followUp, ownerId, campaign, page, reloadKey]);

  function filter<T>(setter: (v: T) => void, value: T) {
    setter(value);
    setPage(1);
  }

  const counts = data?.counts;
  const openCount = counts ? OPEN_LEAD_STATUSES.reduce((n, s) => n + counts[s], 0) : null;
  const allCount = counts ? LEAD_STATUS_VALUES.reduce((n, s) => n + counts[s], 0) : null;
  const chips: { value: StatusFilter; label: string; count: number | null }[] = [
    { value: "open", label: "Open", count: openCount },
    ...LEAD_STATUS_VALUES.map((s) => ({ value: s as StatusFilter, label: LEAD_STATUS_LABELS[s], count: counts?.[s] ?? null })),
    { value: "all", label: "All", count: allCount },
  ];

  const items = data?.items ?? null;
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showOwner = people.length > 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0" role="tablist" aria-label="Lead status">
        {chips.map((chip) => (
          <Button
            key={chip.value}
            size="sm"
            role="tab"
            aria-selected={status === chip.value}
            variant={status === chip.value ? "secondary" : "outline"}
            className="shrink-0"
            onClick={() => filter(setStatus, chip.value)}
          >
            {chip.label}
            {chip.count !== null ? <span className="tabular-nums text-muted-foreground">{chip.count}</span> : null}
          </Button>
        ))}
      </div>

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="grid flex-1 gap-2 sm:grid-cols-2 lg:flex lg:flex-row lg:items-center">
          <div className="relative sm:col-span-2 lg:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Name, phone, campaign…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" aria-label="Search leads" />
          </div>
          <Select value={source} onValueChange={(v) => filter(setSource, v as LeadSourceValue | "all")}>
            <SelectTrigger className="w-full lg:w-44" aria-label="Source">
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
          <Select value={followUp} onValueChange={(v) => filter(setFollowUp, v as LeadFollowUpFilter | "all")}>
            <SelectTrigger className="w-full lg:w-44" aria-label="Follow-up">
              <SelectValue>{(v: string) => (v === "all" ? "Any follow-up" : FOLLOW_UP_LABELS[v as LeadFollowUpFilter])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any follow-up</SelectItem>
              {LEAD_FOLLOW_UP_FILTERS.map((f) => (
                <SelectItem key={f} value={f}>
                  {FOLLOW_UP_LABELS[f]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {showOwner ? (
            <Select value={ownerId} onValueChange={(v) => filter(setOwnerId, v as string)}>
              <SelectTrigger className="w-full lg:w-48" aria-label="Sales executive">
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
          {campaign ? (
            <Button variant="outline" size="sm" onClick={() => filter(setCampaign, "")}>
              Campaign: {campaign} ✕
            </Button>
          ) : null}
        </div>
        {canCreate ? (
          <Button onClick={() => setCreating(true)}>
            <Plus />
            New lead
          </Button>
        ) : null}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!items ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <Users2 className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">No leads here</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {status === "open" && !query && source === "all" && followUp === "all" ? "Every lead has been converted or closed. Add a new one when the next enquiry comes in." : "Try a different filter or search."}
          </p>
        </div>
      ) : (
        <>
          {/* Phones: one card per lead. */}
          <ul className="flex flex-col gap-2 md:hidden">
            {items.map((lead) => (
              <li key={lead.id}>
                <Link href={`/leads/${lead.id}`} className="flex flex-col gap-1 rounded-lg border p-3 active:bg-muted">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium">{lead.name}</span>
                    <LeadStatusBadge status={lead.status} />
                  </div>
                  <div className="flex flex-wrap gap-x-2 text-sm text-muted-foreground">
                    {lead.phone ? <span className="font-mono">{lead.phone}</span> : null}
                    <span>
                      {LEAD_SOURCE_LABELS[lead.source]}
                      {lead.campaign ? ` · ${lead.campaign}` : ""}
                    </span>
                  </div>
                  {lead.interest ? <p className="line-clamp-1 text-sm">{lead.interest}</p> : null}
                  <LeadRowFooter lead={lead} showOwner={showOwner} />
                </Link>
              </li>
            ))}
          </ul>

          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Next follow-up</TableHead>
                  {showOwner ? <TableHead>Executive</TableHead> : null}
                  <TableHead>Added</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((lead) => (
                  <TableRow key={lead.id} className="cursor-pointer" onClick={() => router.push(`/leads/${lead.id}`)}>
                    <TableCell>
                      <Link href={`/leads/${lead.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                        {lead.name}
                      </Link>
                      <div className="text-sm text-muted-foreground">
                        {lead.phone ? <span className="font-mono">{lead.phone}</span> : null}
                        {lead.phone && lead.interest ? " · " : ""}
                        {lead.interest ? <span className="line-clamp-1 inline">{lead.interest}</span> : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>{LEAD_SOURCE_LABELS[lead.source]}</div>
                      {lead.campaign ? (
                        <button
                          type="button"
                          className="text-sm text-muted-foreground hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            filter(setCampaign, lead.campaign!);
                          }}
                        >
                          {lead.campaign}
                        </button>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-0.5">
                        <LeadStatusBadge status={lead.status} />
                        {lead.status === "LOST" && lead.lostReason ? <span className="text-xs text-muted-foreground">{LEAD_LOST_REASON_LABELS[lead.lostReason]}</span> : null}
                        {lead.order ? <span className="font-mono text-xs text-muted-foreground">{lead.order.orderNo}</span> : null}
                      </div>
                    </TableCell>
                    <TableCell>{lead.nextFollowUpAt && isOpenLeadStatus(lead.status) ? <FollowUpTime dueAt={lead.nextFollowUpAt} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                    {showOwner ? <TableCell className="text-muted-foreground">{lead.owner?.name ?? "—"}</TableCell> : null}
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatAdded(lead.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              Page {page} of {totalPages} · {total} lead{total === 1 ? "" : "s"}
            </span>
            <div className="flex gap-1">
              <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
                <ChevronLeft />
              </Button>
              <Button variant="outline" size="icon-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
                <ChevronRight />
              </Button>
            </div>
          </div>
        </>
      )}

      {creating ? (
        <LeadFormDialog
          campaigns={campaigns}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            setReloadKey((k) => k + 1);
          }}
        />
      ) : null}
    </div>
  );
}

const ADDED = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short" });
const formatAdded = (iso: string) => ADDED.format(new Date(iso));

function LeadRowFooter({ lead, showOwner }: { lead: LeadListItem; showOwner: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
      {lead.nextFollowUpAt && isOpenLeadStatus(lead.status) ? (
        <FollowUpTime dueAt={lead.nextFollowUpAt} />
      ) : lead.status === "LOST" && lead.lostReason ? (
        <span className="text-muted-foreground">Lost · {LEAD_LOST_REASON_LABELS[lead.lostReason]}</span>
      ) : lead.order ? (
        <span className="font-mono text-muted-foreground">{lead.order.orderNo}</span>
      ) : (
        <span className="text-muted-foreground">No follow-up set</span>
      )}
      <span className="text-muted-foreground">
        {showOwner && lead.owner ? `${lead.owner.name} · ` : ""}
        {formatAdded(lead.createdAt)}
      </span>
    </div>
  );
}
