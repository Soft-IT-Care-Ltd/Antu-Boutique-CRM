"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { monthLabel } from "@/lib/targets/month";
import type { TargetGoal, TargetPerson, TargetTeam } from "@/lib/targets/types";

export type TargetSubject = { kind: "user" | "team"; id: string; name: string };

/** Set or change one person's or team's target for the month. */
export function TargetDialog({
  month,
  subject,
  current,
  people,
  teams,
  onClose,
  onSaved,
}: {
  month: string;
  subject: TargetSubject | null;
  current: TargetGoal | null;
  people: TargetPerson[];
  teams: TargetTeam[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pick, setPick] = useState(subject ? `${subject.kind}:${subject.id}` : "");
  const [count, setCount] = useState(current?.orderCount ? String(current.orderCount) : "");
  const [value, setValue] = useState(current?.orderValue ? String(Number(current.orderValue)) : "");
  const [note, setNote] = useState(current?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [kind, id] = pick.split(":");
  const canSave = Boolean(id) && (count.trim() !== "" || value.trim() !== "") && !saving;
  const labelFor = (v: string) => {
    const [k, i] = v.split(":");
    return (k === "team" ? teams.find((t) => t.id === i)?.name : people.find((p) => p.id === i)?.name) ?? "Choose who";
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await fetchJson("/api/targets", {
        method: "PUT",
        body: JSON.stringify({
          month,
          userId: kind === "user" ? id : null,
          teamId: kind === "team" ? id : null,
          orderCount: count.trim() ? Number(count) : null,
          orderValue: value.trim() ? Number(value) : null,
          note: note.trim() || null,
        }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the target.");
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{subject ? `Target — ${subject.name}` : "Set a target"}</DialogTitle>
            <DialogDescription>{monthLabel(month)}. An order count, an order value, or both.</DialogDescription>
          </DialogHeader>
          {!subject ? (
            <div className="flex flex-col gap-1.5">
              <Label>For</Label>
              <Select value={pick} onValueChange={(v) => setPick(v as string)}>
                <SelectTrigger className="w-full" aria-label="Person or team">
                  <SelectValue>{(v: string) => (v ? labelFor(v) : "Choose who")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {teams.map((t) => (
                    <SelectItem key={t.id} value={`team:${t.id}`}>
                      {t.name} (team)
                    </SelectItem>
                  ))}
                  {people.map((p) => (
                    <SelectItem key={p.id} value={`user:${p.id}`}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="target-value">Order value (৳)</Label>
              <Input id="target-value" type="number" inputMode="decimal" min={1} step="0.01" value={value} onChange={(e) => setValue(e.target.value)} placeholder="200000" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="target-count">Orders</Label>
              <Input id="target-count" type="number" inputMode="numeric" min={1} step={1} value={count} onChange={(e) => setCount(e.target.value)} placeholder="40" />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="target-note">Note (optional)</Label>
            <Input id="target-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Eid month — higher than usual" />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              Save target
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
