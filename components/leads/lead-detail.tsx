"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarPlus, Check, Loader2, Pencil, RotateCcw, ShoppingBag, Trash2, UserRound } from "lucide-react";

import { FollowUpTimeField } from "@/components/leads/follow-up-time-field";
import { FollowUpTime, LeadStatusBadge } from "@/components/leads/lead-badges";
import { LeadFormDialog } from "@/components/leads/lead-form-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import {
  isOpenLeadStatus,
  LEAD_LOST_REASON_LABELS,
  LEAD_LOST_REASON_VALUES,
  LEAD_SOURCE_LABELS,
  LEAD_STATUS_LABELS,
  OPEN_LEAD_STATUSES,
  type LeadLostReasonValue,
  type LeadStatusValue,
} from "@/lib/leads/constants";
import type { LeadDetail as LeadDetailData, LeadFollowUpView } from "@/lib/leads/types";
import { ApiError, fetchJson } from "@/lib/orders/client";

export type LeadDetailPermissions = { canEdit: boolean; canDelete: boolean; canConvert: boolean };

type Dialogs = { kind: "edit" } | { kind: "lost" } | { kind: "schedule" } | { kind: "complete"; followUp: LeadFollowUpView } | { kind: "delete" } | null;

export function LeadDetail({ lead: initial, campaigns, permissions }: { lead: LeadDetailData; campaigns: string[]; permissions: LeadDetailPermissions }) {
  const router = useRouter();
  const [lead, setLead] = useState(initial);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = isOpenLeadStatus(lead.status);
  const openFollowUps = lead.followUps.filter((f) => !f.completedAt);
  const doneFollowUps = lead.followUps.filter((f) => f.completedAt);

  async function moveTo(status: LeadStatusValue) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchJson<{ lead: LeadDetailData }>(`/api/leads/${lead.id}/status`, { method: "POST", body: JSON.stringify({ status }) });
      setLead(res.lead);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change the status.");
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    const res = await fetchJson<{ lead: LeadDetailData }>(`/api/leads/${lead.id}`);
    setLead(res.lead);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{lead.name}</h1>
            <LeadStatusBadge status={lead.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {LEAD_SOURCE_LABELS[lead.source]}
            {lead.campaign ? ` · ${lead.campaign}` : ""} · added {formatDhakaDateTime(lead.createdAt)}
            {lead.owner ? ` by ${lead.owner.name}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {permissions.canConvert && lead.status !== "CONVERTED" ? (
            <Button render={<Link href={`/orders/new?leadId=${lead.id}`} />} nativeButton={false}>
              <ShoppingBag />
              Convert to order
            </Button>
          ) : null}
          {permissions.canEdit ? (
            <Button variant="outline" onClick={() => setDialog({ kind: "edit" })}>
              <Pencil />
              Edit
            </Button>
          ) : null}
          {permissions.canDelete && lead.status !== "CONVERTED" ? (
            <Button variant="outline" onClick={() => setDialog({ kind: "delete" })} aria-label="Delete lead">
              <Trash2 />
            </Button>
          ) : null}
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {lead.status === "CONVERTED" && lead.order ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/40">
          <Check className="size-4 text-emerald-700 dark:text-emerald-400" />
          Converted {lead.convertedAt ? formatDhakaDateTime(lead.convertedAt) : ""} —
          <Link href={`/orders/${lead.order.id}`} className="font-mono font-medium underline-offset-4 hover:underline">
            {lead.order.orderNo}
          </Link>
        </div>
      ) : null}

      {lead.status === "LOST" ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
          <span>
            Lost{lead.lostAt ? ` ${formatDhakaDateTime(lead.lostAt)}` : ""} — <span className="font-medium">{lead.lostReason ? LEAD_LOST_REASON_LABELS[lead.lostReason] : ""}</span>
            {lead.lostNote ? `: ${lead.lostNote}` : ""}
          </span>
          {permissions.canEdit ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => moveTo("FOLLOW_UP")}>
              <RotateCcw />
              Reopen
            </Button>
          ) : null}
        </div>
      ) : null}

      {permissions.canEdit && open ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Where it stands</CardTitle>
            <CardDescription>Move the lead along as the conversation goes. It becomes Converted when its order is placed.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-1.5">
            {OPEN_LEAD_STATUSES.map((s) => (
              <Button key={s} size="sm" variant={lead.status === s ? "default" : "outline"} disabled={busy} onClick={() => lead.status !== s && moveTo(s)} aria-pressed={lead.status === s}>
                {LEAD_STATUS_LABELS[s]}
              </Button>
            ))}
            <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => setDialog({ kind: "lost" })}>
              Mark lost…
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <Field label="Phone">{lead.phone ? <span className="font-mono">{lead.phone}</span> : "—"}</Field>
            {lead.customer ? (
              <Field label="Customer">
                <Link href={`/customers/${lead.customer.id}`} className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline">
                  <UserRound className="size-3.5" />
                  {lead.customer.name}
                </Link>
              </Field>
            ) : null}
            <Field label="Interested in">{lead.interest ?? "—"}</Field>
            <Field label="Notes">{lead.notes ? <span className="whitespace-pre-wrap">{lead.notes}</span> : "—"}</Field>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div>
              <CardTitle>Follow-ups</CardTitle>
              <CardDescription>{open ? "Reminders show on the dashboard the day they're due, and turn red when overdue." : "This lead is closed — its reminders are off."}</CardDescription>
            </div>
            {permissions.canEdit && open ? (
              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "schedule" })}>
                <CalendarPlus />
                Add
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {openFollowUps.length === 0 && doneFollowUps.length === 0 ? <p className="text-sm text-muted-foreground">No follow-ups yet.</p> : null}
            {openFollowUps.map((f) => (
              <div key={f.id} className="flex items-start justify-between gap-3 rounded-lg border p-3">
                <div className="flex min-w-0 flex-col gap-0.5 text-sm">
                  {open ? <FollowUpTime dueAt={f.dueAt} /> : <span className="text-muted-foreground">{formatDhakaDateTime(f.dueAt)} · off, lead closed</span>}
                  {f.note ? <span>{f.note}</span> : null}
                  {f.createdBy ? <span className="text-xs text-muted-foreground">Set by {f.createdBy.name}</span> : null}
                </div>
                {permissions.canEdit && open ? (
                  <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "complete", followUp: f })}>
                    <Check />
                    Done
                  </Button>
                ) : null}
              </div>
            ))}
            {doneFollowUps.length > 0 ? (
              <ol className="flex flex-col gap-2 border-l pl-3">
                {doneFollowUps
                  .slice()
                  .reverse()
                  .map((f) => (
                    <li key={f.id} className="text-sm">
                      <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                        <Badge variant="outline">Done</Badge>
                        <span>{formatDhakaDateTime(f.completedAt!)}</span>
                        {f.completedBy ? <span>· {f.completedBy.name}</span> : null}
                      </div>
                      {f.note ? <p className="text-muted-foreground">Planned: {f.note}</p> : null}
                      {f.outcome ? <p>{f.outcome}</p> : null}
                    </li>
                  ))}
              </ol>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {dialog?.kind === "edit" ? (
        <LeadFormDialog
          lead={lead}
          campaigns={campaigns}
          onClose={() => setDialog(null)}
          onSaved={async () => {
            setDialog(null);
            await reload();
          }}
        />
      ) : null}
      {dialog?.kind === "lost" ? <LostDialog leadId={lead.id} onClose={() => setDialog(null)} onDone={(l) => (setLead(l), setDialog(null))} /> : null}
      {dialog?.kind === "schedule" ? <ScheduleDialog leadId={lead.id} onClose={() => setDialog(null)} onDone={(l) => (setLead(l), setDialog(null))} /> : null}
      {dialog?.kind === "complete" ? <CompleteFollowUpDialog followUp={dialog.followUp} onClose={() => setDialog(null)} onDone={(l) => (setLead(l), setDialog(null))} /> : null}
      {dialog?.kind === "delete" ? (
        <DeleteDialog
          leadId={lead.id}
          name={lead.name}
          onClose={() => setDialog(null)}
          onDone={() => {
            router.push("/leads");
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function useSubmit<T>(fn: () => Promise<T>, onDone: (value: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      onDone(await fn());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong — try again.");
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function LostDialog({ leadId, onClose, onDone }: { leadId: string; onClose: () => void; onDone: (lead: LeadDetailData) => void }) {
  const [reason, setReason] = useState<LeadLostReasonValue | null>(null);
  const [note, setNote] = useState("");
  const submit = useSubmit(
    () => fetchJson<{ lead: LeadDetailData }>(`/api/leads/${leadId}/status`, { method: "POST", body: JSON.stringify({ status: "LOST", lostReason: reason, lostNote: note.trim() || null }) }).then((r) => r.lead),
    onDone,
  );
  const canSubmit = reason !== null && (reason !== "OTHER" || note.trim() !== "");

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark lead lost</DialogTitle>
          <DialogDescription>Why didn&apos;t it turn into an order? The reasons feed the conversion report.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="Lost reason">
          {LEAD_LOST_REASON_VALUES.map((r) => (
            <Button key={r} type="button" role="radio" aria-checked={reason === r} variant={reason === r ? "secondary" : "outline"} className="justify-start" onClick={() => setReason(r)}>
              {LEAD_LOST_REASON_LABELS[r]}
            </Button>
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lost-note">{reason === "OTHER" ? "What happened" : "Note (optional)"}</Label>
          <Textarea id="lost-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {submit.error ? <p className="text-sm text-destructive">{submit.error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!canSubmit || submit.busy} onClick={submit.run}>
            {submit.busy ? <Loader2 className="animate-spin" /> : null}
            Mark lost
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleDialog({ leadId, onClose, onDone }: { leadId: string; onClose: () => void; onDone: (lead: LeadDetailData) => void }) {
  const [dueAt, setDueAt] = useState("");
  const [note, setNote] = useState("");
  const submit = useSubmit(
    () => fetchJson<{ lead: LeadDetailData }>(`/api/leads/${leadId}/follow-ups`, { method: "POST", body: JSON.stringify({ dueAt, note: note.trim() || null }) }).then((r) => r.lead),
    onDone,
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a follow-up</DialogTitle>
          <DialogDescription>When to get back to them, in Dhaka time.</DialogDescription>
        </DialogHeader>
        <FollowUpTimeField id="schedule-due" value={dueAt} onChange={setDueAt} required />
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What about (optional)" aria-label="Follow-up note" />
        {submit.error ? <p className="text-sm text-destructive">{submit.error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!dueAt || submit.busy} onClick={submit.run}>
            {submit.busy ? <Loader2 className="animate-spin" /> : null}
            Add follow-up
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Done, with what happened — and, in the same step, the next follow-up if there is one. */
export function CompleteFollowUpDialog({ followUp, onClose, onDone }: { followUp: { id: string; note: string | null }; onClose: () => void; onDone: (lead: LeadDetailData) => void }) {
  const [outcome, setOutcome] = useState("");
  const [nextAt, setNextAt] = useState("");
  const submit = useSubmit(
    () =>
      fetchJson<{ lead: LeadDetailData }>(`/api/leads/follow-ups/${followUp.id}`, {
        method: "POST",
        body: JSON.stringify({ outcome: outcome.trim() || null, next: nextAt ? { dueAt: nextAt } : null }),
      }).then((r) => r.lead),
    onDone,
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Follow-up done</DialogTitle>
          <DialogDescription>{followUp.note ? `Planned: ${followUp.note}` : "What happened when you got back to them?"}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="complete-outcome">What happened (optional)</Label>
          <Textarea id="complete-outcome" rows={2} value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Sent the size chart; will confirm tonight" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="complete-next">
            Next follow-up <span className="text-muted-foreground">(optional)</span>
          </Label>
          <FollowUpTimeField id="complete-next" value={nextAt} onChange={setNextAt} />
        </div>
        {submit.error ? <p className="text-sm text-destructive">{submit.error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={submit.busy} onClick={submit.run}>
            {submit.busy ? <Loader2 className="animate-spin" /> : <Check />}
            {nextAt ? "Done, set next" : "Mark done"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ leadId, name, onClose, onDone }: { leadId: string; name: string; onClose: () => void; onDone: () => void }) {
  const submit = useSubmit(() => fetchJson(`/api/leads/${leadId}`, { method: "DELETE" }), onDone);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogDescription>The lead moves to the trash and can be restored for 30 days.</DialogDescription>
        </DialogHeader>
        {submit.error ? <p className="text-sm text-destructive">{submit.error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={submit.busy} onClick={submit.run}>
            {submit.busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Delete lead
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
