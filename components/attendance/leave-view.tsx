"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Loader2, Plus, X } from "lucide-react";

import { formatDay, LeaveStatusBadge } from "@/components/attendance/attendance-badges";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { LEAVE_TYPE_LABELS, LEAVE_TYPE_VALUES, type LeaveTypeValue } from "@/lib/attendance/constants";
import type { LeaveRequestView } from "@/lib/attendance/types";
import { ApiError, fetchJson } from "@/lib/orders/client";

const span = (l: LeaveRequestView) => (l.fromDay === l.toDay ? formatDay(l.fromDay, true) : `${formatDay(l.fromDay, true)} – ${formatDay(l.toDay, true)}`);

/**
 * PRD §4.14 — leave request → TL/Admin approval → the attendance sheet.
 * Everyone asks for their own; approvers see their team's (or everyone's)
 * waiting requests and never decide their own.
 */
export function LeaveView({
  meId,
  canRequest,
  canApprove,
  today,
  mine,
  pending,
  recent,
}: {
  meId: string;
  canRequest: boolean;
  canApprove: boolean;
  today: string;
  mine: LeaveRequestView[];
  pending: LeaveRequestView[];
  recent: LeaveRequestView[] | null;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [deciding, setDeciding] = useState<{ leave: LeaveRequestView; approve: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function cancel(l: LeaveRequestView) {
    setBusy(l.id);
    setError(null);
    try {
      await fetchJson(`/api/attendance/leave/${l.id}`, { method: "PATCH", body: JSON.stringify({ action: "cancel" }) });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not cancel.");
    } finally {
      setBusy(null);
    }
  }

  const ownCancellable = (l: LeaveRequestView) => l.status === "PENDING" || (l.status === "APPROVED" && l.fromDay > today);

  return (
    <div className="flex flex-col gap-4">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {canApprove ? (
        <Card>
          <CardHeader>
            <CardTitle>Waiting for your decision</CardTitle>
            <CardDescription>{pending.length ? `${pending.length} request${pending.length === 1 ? "" : "s"}` : "Nothing waiting."}</CardDescription>
          </CardHeader>
          {pending.length ? (
            <CardContent className="flex flex-col divide-y">
              {pending.map((l) => (
                <div key={l.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm">
                    <p className="font-medium">
                      {l.userName} · {LEAVE_TYPE_LABELS[l.type]} leave
                    </p>
                    <p>
                      {span(l)} <span className="text-muted-foreground">({l.workingDays} working day{l.workingDays === 1 ? "" : "s"})</span>
                    </p>
                    <p className="text-muted-foreground">{l.reason}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setDeciding({ leave: l, approve: true })}>
                      <Check />
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setDeciding({ leave: l, approve: false })}>
                      <X />
                      Reject
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>My leave</CardTitle>
          <CardDescription>Your team leader or a manager approves it; approved leave shows on the attendance sheet.</CardDescription>
          {canRequest ? (
            <CardAction>
              <Button size="sm" onClick={() => setAsking(true)}>
                <Plus />
                Ask for leave
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          {mine.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No leave asked for yet.</p>
          ) : (
            <LeaveList items={mine} renderAction={(l) => (ownCancellable(l) ? <CancelButton busy={busy === l.id} onClick={() => cancel(l)} /> : null)} />
          )}
        </CardContent>
      </Card>

      {recent ? (
        <Card>
          <CardHeader>
            <CardTitle>{canApprove ? "Recent requests" : "Team leave"}</CardTitle>
            <CardDescription>The latest requests from the staff you can see.</CardDescription>
          </CardHeader>
          <CardContent>
            {recent.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No leave requests yet.</p>
            ) : (
              <LeaveList
                items={recent}
                showName
                renderAction={(l) => (canApprove && l.userId !== meId && l.status === "APPROVED" ? <CancelButton busy={busy === l.id} onClick={() => cancel(l)} /> : null)}
              />
            )}
          </CardContent>
        </Card>
      ) : null}

      {asking ? (
        <LeaveRequestDialog
          today={today}
          onClose={() => setAsking(false)}
          onSaved={() => {
            setAsking(false);
            router.refresh();
          }}
        />
      ) : null}
      {deciding ? (
        <DecisionDialog
          {...deciding}
          onClose={() => setDeciding(null)}
          onSaved={() => {
            setDeciding(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function CancelButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" onClick={onClick} disabled={busy}>
      {busy ? <Loader2 className="animate-spin" /> : null}
      Cancel
    </Button>
  );
}

function LeaveList({ items, showName = false, renderAction }: { items: LeaveRequestView[]; showName?: boolean; renderAction: (l: LeaveRequestView) => React.ReactNode }) {
  return (
    <div className="flex flex-col divide-y">
      {items.map((l) => (
        <div key={l.id} className="flex flex-col gap-1 py-3 text-sm first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-0.5">
            <p className="font-medium">
              {showName ? `${l.userName} · ` : ""}
              {LEAVE_TYPE_LABELS[l.type]} · {span(l)}{" "}
              <span className="font-normal text-muted-foreground">
                ({l.workingDays} working day{l.workingDays === 1 ? "" : "s"})
              </span>
            </p>
            <p className="text-muted-foreground">{l.reason}</p>
            {l.decidedBy ? (
              <p className="text-xs text-muted-foreground">
                {l.status === "REJECTED" ? "Rejected" : "Approved"} by {l.decidedBy}
                {l.decisionNote ? ` — “${l.decisionNote}”` : ""}
              </p>
            ) : null}
            {l.cancelledBy ? <p className="text-xs text-muted-foreground">Cancelled by {l.cancelledBy}</p> : null}
          </div>
          <div className="flex items-center gap-2">
            <LeaveStatusBadge status={l.status} />
            {renderAction(l)}
          </div>
        </div>
      ))}
    </div>
  );
}

function LeaveRequestDialog({ today, onClose, onSaved }: { today: string; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState<LeaveTypeValue>("CASUAL");
  const [fromDay, setFromDay] = useState(today);
  const [toDay, setToDay] = useState(today);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSave = fromDay !== "" && toDay >= fromDay && reason.trim().length >= 3 && !saving;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await fetchJson("/api/attendance/leave", { method: "POST", body: JSON.stringify({ type, fromDay, toDay, reason: reason.trim() }) });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the request.");
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Ask for leave</DialogTitle>
            <DialogDescription>Weekly off days and holidays inside the dates don&apos;t use leave.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as LeaveTypeValue)}>
              <SelectTrigger className="w-full">
                <SelectValue>{(v: LeaveTypeValue) => LEAVE_TYPE_LABELS[v]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {LEAVE_TYPE_VALUES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {LEAVE_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="leave-from">From</Label>
              <Input
                id="leave-from"
                type="date"
                value={fromDay}
                onChange={(e) => {
                  setFromDay(e.target.value);
                  if (toDay < e.target.value) setToDay(e.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="leave-to">To</Label>
              <Input id="leave-to" type="date" min={fromDay} value={toDay} onChange={(e) => setToDay(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="leave-reason">Reason</Label>
            <Textarea id="leave-reason" maxLength={500} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Sister's wedding in Cumilla" />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              Send request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DecisionDialog({ leave, approve, onClose, onSaved }: { leave: LeaveRequestView; approve: boolean; onClose: () => void; onSaved: () => void }) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSave = (approve || note.trim() !== "") && !saving;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await fetchJson(`/api/attendance/leave/${leave.id}`, { method: "PATCH", body: JSON.stringify({ action: approve ? "approve" : "reject", note: note.trim() || null }) });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the decision.");
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {approve ? "Approve" : "Reject"} {leave.userName}&apos;s leave
            </DialogTitle>
            <DialogDescription>
              {LEAVE_TYPE_LABELS[leave.type]} · {span(leave)} · {leave.workingDays} working day{leave.workingDays === 1 ? "" : "s"}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="decision-note">{approve ? "Note (optional)" : "Why not?"}</Label>
            <Textarea id="decision-note" maxLength={300} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Back
            </Button>
            <Button type="submit" variant={approve ? "default" : "destructive"} disabled={!canSave}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              {approve ? "Approve" : "Reject"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
