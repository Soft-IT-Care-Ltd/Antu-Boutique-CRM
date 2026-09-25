"use client";

import { useEffect, useState } from "react";
import { Loader2, UserCheck } from "lucide-react";

import { FollowUpTimeField } from "@/components/leads/follow-up-time-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { isValidBdPhone, normalizeBdPhone } from "@/lib/customers/phone";
import type { CustomerListItem } from "@/lib/customers/types";
import { LEAD_SOURCE_LABELS, LEAD_SOURCE_VALUES, type LeadSourceValue } from "@/lib/leads/constants";
import type { LeadDetail } from "@/lib/leads/types";
import { ApiError, fetchJson } from "@/lib/orders/client";

type FormState = {
  name: string;
  phone: string;
  source: LeadSourceValue | "";
  campaign: string;
  interest: string;
  notes: string;
  followUpAt: string;
  followUpNote: string;
};

/** New lead, or edit one (no follow-up fields — those live on the lead). */
export function LeadFormDialog({
  lead,
  campaigns,
  onClose,
  onSaved,
}: {
  lead?: LeadDetail;
  campaigns: string[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const isEdit = Boolean(lead);
  const [form, setForm] = useState<FormState>({
    name: lead?.name ?? "",
    phone: lead?.phone ?? "",
    source: lead?.source ?? "",
    campaign: lead?.campaign ?? "",
    interest: lead?.interest ?? "",
    notes: lead?.notes ?? "",
    followUpAt: "",
    followUpNote: "",
  });
  const [known, setKnown] = useState<CustomerListItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  // A number that's already a customer (one this user can see) is a repeat
  // buyer — say so, and offer the matching source.
  const phoneValid = isValidBdPhone(form.phone);
  useEffect(() => {
    if (!phoneValid) return;
    const phone = normalizeBdPhone(form.phone);
    let live = true;
    const timer = setTimeout(() => {
      fetchJson<{ items: CustomerListItem[] }>(`/api/customers?q=${encodeURIComponent(phone)}&pageSize=5`)
        .then((d) => live && setKnown(d.items.find((c) => c.phone === phone) ?? null))
        .catch(() => live && setKnown(null));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [form.phone, phoneValid]);
  const knownCustomer = phoneValid ? known : null;

  const phoneInvalid = form.phone.trim() !== "" && !phoneValid;
  const canSubmit = form.name.trim() !== "" && form.source !== "" && !phoneInvalid && !saving;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    const body = {
      name: form.name.trim(),
      phone: form.phone.trim() || null,
      source: form.source,
      campaign: form.campaign.trim() || null,
      interest: form.interest.trim() || null,
      notes: form.notes.trim() || null,
      ...(isEdit ? {} : { followUpAt: form.followUpAt || null, followUpNote: form.followUpNote.trim() || null }),
    };
    try {
      if (lead) {
        await fetchJson(`/api/leads/${lead.id}`, { method: "PATCH", body: JSON.stringify(body) });
        onSaved(lead.id);
      } else {
        const created = await fetchJson<{ id: string }>("/api/leads", { method: "POST", body: JSON.stringify(body) });
        onSaved(created.id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the lead.");
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit lead" : "New lead"}</DialogTitle>
            <DialogDescription>Who asked, where they came from, and what they want. Only the name and source are required.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="lead-name">Name</Label>
              <Input id="lead-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="As on Messenger" required autoFocus />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="lead-phone">
                Phone <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input id="lead-phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="017XXXXXXXX" inputMode="tel" aria-invalid={phoneInvalid} />
              {phoneInvalid ? <p className="text-xs text-destructive">Enter a valid Bangladeshi mobile number.</p> : null}
            </div>
          </div>

          {knownCustomer ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 p-2.5 text-sm">
              <span className="flex items-center gap-1.5">
                <UserCheck className="size-4 text-muted-foreground" />
                Existing customer: <span className="font-medium">{knownCustomer.name}</span>
              </span>
              {form.source !== "REPEAT_CUSTOMER" ? (
                <Button type="button" size="xs" variant="outline" onClick={() => set("source", "REPEAT_CUSTOMER")}>
                  Mark as repeat customer
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Source</Label>
              <Select value={form.source || null} onValueChange={(v) => set("source", (v as LeadSourceValue | null) ?? "")}>
                <SelectTrigger className="w-full" aria-label="Source">
                  <SelectValue placeholder="Where did they come from?">{(v: LeadSourceValue | null) => (v ? LEAD_SOURCE_LABELS[v] : "Where did they come from?")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {LEAD_SOURCE_VALUES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {LEAD_SOURCE_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="lead-campaign">
                Campaign <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input id="lead-campaign" value={form.campaign} onChange={(e) => set("campaign", e.target.value)} list="lead-campaigns" placeholder="e.g. Eid Collection" />
              <datalist id="lead-campaigns">
                {campaigns.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lead-interest">
              Interested in <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input id="lead-interest" value={form.interest} onChange={(e) => set("interest", e.target.value)} placeholder="Maroon kurti, size M — from Friday's post" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lead-notes">
              Notes <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea id="lead-notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} />
          </div>

          {!isEdit ? (
            <div className="flex flex-col gap-2 rounded-lg border p-3">
              <Label htmlFor="lead-followup">
                First follow-up <span className="text-muted-foreground">(optional)</span>
              </Label>
              <FollowUpTimeField id="lead-followup" value={form.followUpAt} onChange={(v) => set("followUpAt", v)} />
              {form.followUpAt ? <Input value={form.followUpNote} onChange={(e) => set("followUpNote", e.target.value)} placeholder="What to follow up about (optional)" aria-label="Follow-up note" /> : null}
            </div>
          ) : null}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              {isEdit ? "Save changes" : "Add lead"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
