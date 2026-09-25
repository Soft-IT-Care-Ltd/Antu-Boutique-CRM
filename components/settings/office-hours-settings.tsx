"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WEEKDAY_LABELS, type OfficeHours } from "@/lib/attendance/office-hours";
import { ApiError, fetchJson } from "@/lib/orders/client";

// PRD §4.17 "office hours and late rule" — what makes a check-in Late or a
// Half day (PRD §4.14). A change applies to days recorded from then on.
export function OfficeHoursSettings({ initial }: { initial: OfficeHours }) {
  const [hours, setHours] = useState(initial);
  const [holiday, setHoliday] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof OfficeHours>(key: K, value: OfficeHours[K]) => setHours((h) => ({ ...h, [key]: value }));

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const { officeHours } = await fetchJson<{ officeHours: OfficeHours }>("/api/settings/office-hours", { method: "PUT", body: JSON.stringify(hours) });
      setHours(officeHours);
      setMessage({ ok: true, text: "Saved — applies to days recorded from now on." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not save." });
    } finally {
      setSaving(false);
    }
  }

  const num = (v: string) => (v === "" ? 0 : Number(v));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Office hours &amp; late rule</CardTitle>
        <CardDescription>Turns each check-in into Present, Late or Half day. Days already recorded keep the status they were given.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="oh-start">Opens</Label>
            <Input id="oh-start" type="time" value={hours.start} onChange={(e) => set("start", e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="oh-end">Closes</Label>
            <Input id="oh-end" type="time" value={hours.end} onChange={(e) => set("end", e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="oh-grace">Late after (min)</Label>
            <Input id="oh-grace" type="number" min={0} max={180} value={hours.lateGraceMinutes} onChange={(e) => set("lateGraceMinutes", num(e.target.value))} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="oh-half">Half day from (min late)</Label>
            <Input id="oh-half" type="number" min={1} max={720} value={hours.halfDayAfterMinutes} onChange={(e) => set("halfDayAfterMinutes", num(e.target.value))} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="oh-min">Half day if under (hours)</Label>
            <Input id="oh-min" type="number" min={0.5} max={12} step={0.5} value={hours.halfDayMinHours} onChange={(e) => set("halfDayMinHours", num(e.target.value))} />
          </div>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Weekly off</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {WEEKDAY_LABELS.map((label, i) => (
              <label key={label} className="flex items-center gap-2 text-sm">
                <Checkbox checked={hours.weeklyOff.includes(i)} onCheckedChange={(on) => set("weeklyOff", on ? [...hours.weeklyOff, i] : hours.weeklyOff.filter((d) => d !== i))} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-col gap-2">
          <Label htmlFor="oh-holiday">Holidays</Label>
          <div className="flex gap-2">
            <Input id="oh-holiday" type="date" className="w-44" value={holiday} onChange={(e) => setHoliday(e.target.value)} />
            <Button
              type="button"
              variant="outline"
              disabled={!holiday || hours.holidays.includes(holiday)}
              onClick={() => {
                set("holidays", [...hours.holidays, holiday].sort());
                setHoliday("");
              }}
            >
              Add
            </Button>
          </div>
          {hours.holidays.length ? (
            <div className="flex flex-wrap gap-1.5">
              {hours.holidays.map((d) => (
                <span key={d} className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-sm tabular-nums">
                  {d}
                  <button type="button" aria-label={`Remove ${d}`} onClick={() => set("holidays", hours.holidays.filter((x) => x !== d))}>
                    <X className="size-3.5" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No holidays added. A holiday is never counted as absent.</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
          {message ? <p className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}
