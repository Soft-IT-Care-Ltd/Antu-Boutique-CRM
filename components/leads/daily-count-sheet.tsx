"use client";

import { useEffect, useState } from "react";
import { CalendarDays, Loader2, Plus, Save, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { newLocalId } from "@/lib/browser/local-id";
import { formatDhakaDate, formatDhakaDateTime } from "@/lib/inventory/constants";
import { LEAD_SOURCE_LABELS, LEAD_SOURCE_VALUES, type LeadSourceValue } from "@/lib/leads/constants";
import type { DailyCountDay, DailyCountRow, DailyCountSheet as Sheet, LeadPerson } from "@/lib/leads/types";
import { ApiError, fetchJson } from "@/lib/orders/client";

type Counts = { leads: string; converted: string };
type CampaignRow = { localId: string; source: LeadSourceValue; campaign: string } & Counts;

const blank = (): Counts => ({ leads: "", converted: "" });
const num = (v: string) => (v.trim() === "" ? 0 : Number(v));
const bad = (c: Counts) => !Number.isInteger(num(c.leads)) || !Number.isInteger(num(c.converted)) || num(c.leads) < 0 || num(c.converted) < 0 || num(c.converted) > num(c.leads);

function fromSheet(rows: DailyCountRow[]) {
  const bySource = Object.fromEntries(LEAD_SOURCE_VALUES.map((s) => [s, blank()])) as Record<LeadSourceValue, Counts>;
  const campaigns: CampaignRow[] = [];
  for (const r of rows) {
    const counts = { leads: String(r.leadCount), converted: r.convertedCount ? String(r.convertedCount) : "" };
    if (r.campaign) campaigns.push({ localId: newLocalId(), source: r.source, campaign: r.campaign, ...counts });
    else bySource[r.source] = counts;
  }
  return { bySource, campaigns };
}

/**
 * PRD §4.5 bulk daily-count quick entry: on a day too busy to record each
 * lead, type how many came from each source (and how many bought). Saving
 * replaces that person's counts for the day.
 */
export function DailyCountSheet({ people, currentUserId, today, campaigns: campaignSuggestions, canSave }: { people: LeadPerson[]; currentUserId: string; today: string; campaigns: string[]; canSave: boolean }) {
  const [userId, setUserId] = useState(people.some((p) => p.id === currentUserId) ? currentUserId : (people[0]?.id ?? ""));
  const [day, setDay] = useState(today);
  const [bySource, setBySource] = useState<Record<LeadSourceValue, Counts> | null>(null);
  const [campaignRows, setCampaignRows] = useState<CampaignRow[]>([]);
  const [saved, setSaved] = useState<Pick<Sheet, "updatedAt" | "enteredBy"> | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [history, setHistory] = useState<DailyCountDay[] | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  // Which person/day the loaded sheet belongs to — a skeleton until the picked one arrives.
  const sheetKey = `${userId}|${day}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  function pick(next: { userId?: string; day?: string }) {
    setMessage(null);
    if (next.userId) setUserId(next.userId);
    if (next.day) setDay(next.day);
  }

  useEffect(() => {
    if (!userId || !day) return;
    let live = true;
    fetchJson<{ sheet: Sheet }>(`/api/leads/daily-counts?userId=${userId}&day=${day}`)
      .then(({ sheet }) => {
        if (!live) return;
        const parsed = fromSheet(sheet.rows);
        setBySource(parsed.bySource);
        setCampaignRows(parsed.campaigns);
        setSaved({ updatedAt: sheet.updatedAt, enteredBy: sheet.enteredBy });
        setLoadedKey(`${userId}|${day}`);
      })
      .catch((err) => live && setMessage({ error: true, text: err instanceof ApiError ? err.message : "Could not load that day." }));
    return () => {
      live = false;
    };
  }, [userId, day]);

  useEffect(() => {
    const from = new Date(Date.parse(`${today}T00:00:00Z`) - 13 * 86_400_000).toISOString().slice(0, 10);
    let live = true;
    fetchJson<{ days: DailyCountDay[] }>(`/api/leads/daily-counts?from=${from}&to=${today}`)
      .then((d) => live && setHistory(d.days))
      .catch(() => live && setHistory([]));
    return () => {
      live = false;
    };
  }, [today, historyKey]);

  const ready = bySource !== null && loadedKey === sheetKey;
  const allRows = bySource ? [...LEAD_SOURCE_VALUES.map((s) => bySource[s]), ...campaignRows] : [];
  const totalLeads = allRows.reduce((n, c) => n + (num(c.leads) || 0), 0);
  const totalConverted = allRows.reduce((n, c) => n + (num(c.converted) || 0), 0);
  const invalid = allRows.some(bad) || campaignRows.some((r) => num(r.leads) > 0 && !r.campaign.trim());

  async function save() {
    if (!bySource || !ready || invalid) return;
    setSaving(true);
    setMessage(null);
    const rows = [
      ...LEAD_SOURCE_VALUES.map((s) => ({ source: s, campaign: null, leadCount: num(bySource[s].leads), convertedCount: num(bySource[s].converted) })),
      ...campaignRows.map((r) => ({ source: r.source, campaign: r.campaign.trim() || null, leadCount: num(r.leads), convertedCount: num(r.converted) })),
    ].filter((r) => r.leadCount > 0);
    try {
      const { sheet } = await fetchJson<{ sheet: Sheet }>("/api/leads/daily-counts", { method: "PUT", body: JSON.stringify({ userId, day, rows }) });
      const parsed = fromSheet(sheet.rows);
      setBySource(parsed.bySource);
      setCampaignRows(parsed.campaigns);
      setSaved({ updatedAt: sheet.updatedAt, enteredBy: sheet.enteredBy });
      setMessage({ error: false, text: rows.length === 0 ? "Counts cleared for the day." : "Saved." });
      setHistoryKey((k) => k + 1);
    } catch (err) {
      setMessage({ error: true, text: err instanceof ApiError ? err.message : "Could not save the counts." });
    } finally {
      setSaving(false);
    }
  }

  const updateCampaign = (localId: string, patch: Partial<CampaignRow>) => setCampaignRows((rows) => rows.map((r) => (r.localId === localId ? { ...r, ...patch } : r)));

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <CardHeader>
          <CardTitle>Count for a day</CardTitle>
          <CardDescription>How many leads came in from each source, and how many of those bought. Leave a row empty for none.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="count-day">Day</Label>
              <Input id="count-day" type="date" value={day} max={today} onChange={(e) => e.target.value && pick({ day: e.target.value })} />
            </div>
            {people.length > 1 ? (
              <div className="flex flex-col gap-1.5">
                <Label>Sales executive</Label>
                <Select value={userId} onValueChange={(v) => pick({ userId: v as string })}>
                  <SelectTrigger className="w-full" aria-label="Sales executive">
                    <SelectValue>{(v: string) => people.find((p) => p.id === v)?.name ?? "Pick someone"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {people.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          {!ready || !bySource ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_5rem_5rem] items-center gap-2 text-xs font-medium text-muted-foreground">
                <span>Source</span>
                <span className="text-right">Leads</span>
                <span className="text-right">Bought</span>
              </div>
              {LEAD_SOURCE_VALUES.map((s) => (
                <div key={s} className="grid grid-cols-[1fr_5rem_5rem] items-center gap-2">
                  <Label htmlFor={`count-${s}`} className="font-normal">
                    {LEAD_SOURCE_LABELS[s]}
                  </Label>
                  <CountInput id={`count-${s}`} label={`${LEAD_SOURCE_LABELS[s]} leads`} value={bySource[s].leads} onChange={(v) => setBySource({ ...bySource, [s]: { ...bySource[s], leads: v } })} disabled={!canSave} />
                  <CountInput
                    label={`${LEAD_SOURCE_LABELS[s]} bought`}
                    value={bySource[s].converted}
                    onChange={(v) => setBySource({ ...bySource, [s]: { ...bySource[s], converted: v } })}
                    invalid={bad(bySource[s])}
                    disabled={!canSave}
                  />
                </div>
              ))}

              {campaignRows.length > 0 ? <p className="mt-2 text-xs font-medium text-muted-foreground">From a campaign</p> : null}
              {campaignRows.map((r) => (
                <div key={r.localId} className="flex flex-col gap-2 rounded-lg border p-2 sm:grid sm:grid-cols-[9rem_1fr_5rem_5rem_2rem] sm:items-center sm:border-0 sm:p-0">
                  <Select value={r.source} onValueChange={(v) => updateCampaign(r.localId, { source: v as LeadSourceValue })} disabled={!canSave}>
                    <SelectTrigger className="w-full" aria-label="Campaign source">
                      <SelectValue>{(v: LeadSourceValue) => LEAD_SOURCE_LABELS[v]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {LEAD_SOURCE_VALUES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {LEAD_SOURCE_LABELS[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input value={r.campaign} onChange={(e) => updateCampaign(r.localId, { campaign: e.target.value })} list="count-campaigns" placeholder="Campaign name" aria-label="Campaign name" disabled={!canSave} />
                  <div className="grid grid-cols-[1fr_1fr_2rem] gap-2 sm:contents">
                    <CountInput label="Campaign leads" value={r.leads} onChange={(v) => updateCampaign(r.localId, { leads: v })} disabled={!canSave} />
                    <CountInput label="Campaign bought" value={r.converted} onChange={(v) => updateCampaign(r.localId, { converted: v })} invalid={bad(r)} disabled={!canSave} />
                    <Button type="button" variant="ghost" size="icon-sm" onClick={() => setCampaignRows((rows) => rows.filter((x) => x.localId !== r.localId))} aria-label="Remove campaign row" disabled={!canSave}>
                      <X />
                    </Button>
                  </div>
                </div>
              ))}
              <datalist id="count-campaigns">
                {campaignSuggestions.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>

              {canSave ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => setCampaignRows((rows) => [...rows, { localId: newLocalId(), source: "FACEBOOK_AD", campaign: "", ...blank() }])}
                >
                  <Plus />
                  Add a campaign row
                </Button>
              ) : null}

              <div className="mt-2 grid grid-cols-[1fr_5rem_5rem] items-center gap-2 border-t pt-2 font-medium">
                <span>Total</span>
                <span className="text-right tabular-nums">{totalLeads}</span>
                <span className="text-right tabular-nums">{totalConverted}</span>
              </div>
              {invalid ? <p className="text-sm text-destructive">Use whole numbers, never more bought than leads, and name each campaign row.</p> : null}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {saved?.updatedAt ? `Last saved ${formatDhakaDateTime(saved.updatedAt)}${saved.enteredBy ? ` by ${saved.enteredBy.name}` : ""}` : "Nothing saved for this day yet."}
                </span>
                {canSave ? (
                  <Button onClick={save} disabled={saving || invalid}>
                    {saving ? <Loader2 className="animate-spin" /> : <Save />}
                    Save counts
                  </Button>
                ) : null}
              </div>
              {message ? <p className={message.error ? "text-sm text-destructive" : "text-sm text-emerald-700 dark:text-emerald-400"}>{message.text}</p> : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Last 14 days</CardTitle>
          <CardDescription>Days with counts saved. Pick one to see or correct it.</CardDescription>
        </CardHeader>
        <CardContent>
          {!history ? (
            <Skeleton className="h-32 w-full" />
          ) : history.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
              <CalendarDays className="size-6" />
              No counts in the last two weeks.
            </div>
          ) : (
            <ul className="flex flex-col divide-y">
              {history.map((d) => (
                <li key={`${d.day}-${d.userId}`}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 py-2 text-left text-sm hover:bg-muted/50"
                    onClick={() => {
                      pick({ userId: people.some((p) => p.id === d.userId) ? d.userId : undefined, day: d.day });
                    }}
                  >
                    <span>
                      <span className="font-medium">{formatDhakaDate(`${d.day}T00:00:00+06:00`)}</span>
                      {people.length > 1 ? <span className="text-muted-foreground"> · {d.userName}</span> : null}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {d.leadCount} leads · {d.convertedCount} bought
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CountInput({ id, label, value, onChange, invalid, disabled }: { id?: string; label: string; value: string; onChange: (v: string) => void; invalid?: boolean; disabled?: boolean }) {
  return (
    <Input
      id={id}
      aria-label={label}
      type="number"
      inputMode="numeric"
      min={0}
      step={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="0"
      className="text-right tabular-nums"
      aria-invalid={invalid}
      disabled={disabled}
    />
  );
}
