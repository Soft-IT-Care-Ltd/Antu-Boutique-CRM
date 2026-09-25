"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

import { formatClockTime, formatDay, MARK_CLASS } from "@/components/attendance/attendance-badges";
import { MarkLegend } from "@/components/attendance/month-strip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { DAY_MARK_CODES, DAY_MARK_LABELS } from "@/lib/attendance/constants";
import { formatClock } from "@/lib/attendance/office-hours";
import type { AttendanceDay, AttendancePerson, AttendanceSheet } from "@/lib/attendance/types";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { monthLabel } from "@/lib/targets/month";
import { cn } from "@/lib/utils";

const DHAKA_HHMM = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit", hour12: false });
const hhmm = (iso: string | null | undefined) => (iso ? DHAKA_HHMM.format(new Date(iso)) : "");

/**
 * PRD §4.14 monthly attendance report: a summary per staff member and the
 * day-by-day sheet. attendance.manage corrects a day from its cell.
 */
export function AttendanceReport({ sheet, people, userId, canExport, canCorrect }: { sheet: AttendanceSheet; people: AttendancePerson[]; userId: string | null; canExport: boolean; canCorrect: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [correcting, setCorrecting] = useState<{ userId: string; name: string; day: AttendanceDay } | null>(null);

  const setPerson = (v: string) => {
    const next = new URLSearchParams(params.toString());
    if (v === "all") next.delete("userId");
    else next.set("userId", v);
    router.push(`${pathname}?${next}`);
  };
  const csv = `/api/attendance/sheet?${new URLSearchParams({ month: sheet.month, ...(userId ? { userId } : {}), format: "csv" })}`;
  const oh = sheet.officeHours;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {people.length > 1 ? (
          <Select value={userId ?? "all"} onValueChange={(v) => setPerson(v as string)}>
            <SelectTrigger className="w-full sm:w-56" aria-label="Staff member">
              <SelectValue>{(v: string) => (v === "all" ? "All staff" : (people.find((p) => p.id === v)?.name ?? "All staff"))}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All staff</SelectItem>
              {people.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Office {formatClock(oh.start)} – {formatClock(oh.end)}, late after {oh.lateGraceMinutes} min, half day from {oh.halfDayAfterMinutes} min late or under {oh.halfDayMinHours} h.
        </p>
        {canExport ? (
          <Button variant="outline" className="sm:ml-auto" render={<a href={csv} download />} nativeButton={false}>
            <Download />
            CSV
          </Button>
        ) : null}
      </div>

      {sheet.rows.length === 0 ? (
        <div className="rounded-lg border border-dashed py-16 text-center text-sm text-muted-foreground">No staff to show.</div>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{monthLabel(sheet.month)} summary</CardTitle>
              <CardDescription>Counted up to today. Late includes half days that started late.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Staff</TableHead>
                      <TableHead className="text-right">Working days</TableHead>
                      <TableHead className="text-right">Present</TableHead>
                      <TableHead className="text-right">Late</TableHead>
                      <TableHead className="text-right">Half day</TableHead>
                      <TableHead className="text-right">Absent</TableHead>
                      <TableHead className="text-right">Leave</TableHead>
                      <TableHead className="hidden text-right md:table-cell">No check-out</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sheet.rows.map((r) => (
                      <TableRow key={r.userId}>
                        <TableCell>
                          <span className="font-medium">{r.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {r.role}
                            {r.teamName ? ` · ${r.teamName}` : ""}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{r.totals.workingDays}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.totals.present}
                          {r.totals.offDaysWorked ? <span className="block text-xs text-muted-foreground">{r.totals.offDaysWorked} on off days</span> : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.totals.late}
                          {r.totals.lateMinutes ? <span className="block text-xs text-muted-foreground">{r.totals.lateMinutes} min</span> : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{r.totals.halfDay}</TableCell>
                        <TableCell className={cn("text-right tabular-nums", r.totals.absent > 0 && "font-medium text-destructive")}>{r.totals.absent}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.totals.leave}</TableCell>
                        <TableCell className="hidden text-right tabular-nums md:table-cell">{r.totals.noCheckOut}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Attendance sheet</CardTitle>
              <CardDescription>{canCorrect ? "Tap a day to correct its times." : "Hover or tap a day for its times."}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                <table className="border-separate border-spacing-0.5 text-xs">
                  <thead>
                    <tr>
                      <th className="sticky left-0 z-10 bg-card pr-2 text-left font-medium">Staff</th>
                      {sheet.days.map((d) => (
                        <th key={d.day} className={cn("w-8 min-w-8 text-center font-normal", d.kind !== "WORKING" && "text-muted-foreground", d.day === sheet.today && "font-semibold underline")}>
                          {Number(d.day.slice(8))}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.rows.map((r) => (
                      <tr key={r.userId}>
                        <td className="sticky left-0 z-10 max-w-32 truncate bg-card pr-2 font-medium">{r.name}</td>
                        {r.days.map((d) => {
                          const title = `${formatDay(d.day, true)} — ${DAY_MARK_LABELS[d.mark]}${d.record ? ` · in ${formatClockTime(d.record.checkInAt)}${d.record.checkOutAt ? `, out ${formatClockTime(d.record.checkOutAt)}` : ", no check-out"}` : ""}${d.record?.corrected ? " · corrected" : ""}`;
                          const clickable = canCorrect && d.day <= sheet.today;
                          return (
                            <td key={d.day} className="p-0">
                              <button
                                type="button"
                                title={title}
                                aria-label={`${r.name}, ${title}`}
                                disabled={!clickable}
                                onClick={() => setCorrecting({ userId: r.userId, name: r.name, day: d })}
                                className={cn(
                                  "relative flex h-8 w-8 items-center justify-center rounded font-semibold",
                                  MARK_CLASS[d.mark],
                                  d.mark === "NONE" && "border border-dashed",
                                  clickable && "cursor-pointer hover:ring-2 hover:ring-ring",
                                  d.noCheckOut && "underline decoration-dotted",
                                )}
                              >
                                {DAY_MARK_CODES[d.mark]}
                                {d.record?.corrected ? <span className="absolute top-0.5 right-0.5 size-1 rounded-full bg-current" aria-hidden /> : null}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <MarkLegend />
              <p className="text-xs text-muted-foreground">Dotted underline: checked in but never checked out. Dot in the corner: corrected by a manager.</p>
            </CardContent>
          </Card>
        </>
      )}

      {correcting ? (
        <CorrectionDialog
          {...correcting}
          onClose={() => setCorrecting(null)}
          onSaved={() => {
            setCorrecting(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function CorrectionDialog({ userId, name, day, onClose, onSaved }: { userId: string; name: string; day: AttendanceDay; onClose: () => void; onSaved: () => void }) {
  const [checkIn, setCheckIn] = useState(hhmm(day.record?.checkInAt) || "10:00");
  const [checkOut, setCheckOut] = useState(hhmm(day.record?.checkOutAt));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSave = checkIn !== "" && reason.trim().length >= 3 && !saving;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await fetchJson("/api/attendance/records", { method: "PUT", body: JSON.stringify({ userId, day: day.day, checkIn, checkOut: checkOut || null, reason: reason.trim() }) });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the correction.");
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              Correct {name} — {formatDay(day.day, true)}
            </DialogTitle>
            <DialogDescription>
              Now: {DAY_MARK_LABELS[day.mark]}. Late / half day is worked out again from the office hours. The change and your reason are logged.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fix-in">Check-in</Label>
              <Input id="fix-in" type="time" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fix-out">Check-out</Label>
              <Input id="fix-out" type="time" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fix-reason">Reason</Label>
            <Textarea id="fix-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Phone was dead — arrived 9:55, confirmed by TL" />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              Save correction
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
