"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { REWARD_METRIC_LABELS, REWARD_METRIC_UNIT, REWARD_METRIC_VALUES, REWARD_SCOPE_LABELS, REWARD_SCOPE_VALUES, type RewardMetricValue, type RewardScopeValue } from "@/lib/targets/constants";
import type { RewardRuleView } from "@/lib/targets/types";

const UNIT_HINT = { percent: "%", money: "৳", count: "orders" } as const;

export function RewardRuleDialog({ rule, onClose, onSaved }: { rule: RewardRuleView | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(rule?.name ?? "");
  const [scope, setScope] = useState<RewardScopeValue>(rule?.scope ?? "INDIVIDUAL");
  const [metric, setMetric] = useState<RewardMetricValue>(rule?.metric ?? "VALUE_TARGET_PERCENT");
  const [threshold, setThreshold] = useState(rule ? String(Number(rule.threshold)) : "");
  const [minRate, setMinRate] = useState(rule?.minDeliveredRate ? String(rule.minDeliveredRate) : "");
  const [amount, setAmount] = useState(rule?.rewardAmount ? String(Number(rule.rewardAmount)) : "");
  const [note, setNote] = useState(rule?.rewardNote ?? "");
  const [active, setActive] = useState(rule?.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim() !== "" && threshold.trim() !== "" && (amount.trim() !== "" || note.trim() !== "") && !saving;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const body = JSON.stringify({
      name: name.trim(),
      scope,
      metric,
      threshold: Number(threshold),
      minDeliveredRate: minRate.trim() ? Number(minRate) : null,
      rewardAmount: amount.trim() ? Number(amount) : null,
      rewardNote: note.trim() || null,
      isActive: active,
    });
    try {
      if (rule) await fetchJson(`/api/targets/rewards/rules/${rule.id}`, { method: "PATCH", body });
      else await fetchJson("/api/targets/rewards/rules", { method: "POST", body });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the rule.");
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{rule ? "Edit reward rule" : "New reward rule"}</DialogTitle>
            <DialogDescription>
              Worked out at month end. Rules on the same measure are tiers — only the highest one reached pays. Past months keep what they earned.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-name">Name</Label>
            <Input id="rule-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Target hit bonus" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>Applies to</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as RewardScopeValue)}>
                <SelectTrigger className="w-full">
                  <SelectValue>{(v: RewardScopeValue) => REWARD_SCOPE_LABELS[v]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {REWARD_SCOPE_VALUES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {REWARD_SCOPE_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Measure</Label>
              <Select value={metric} onValueChange={(v) => setMetric(v as RewardMetricValue)}>
                <SelectTrigger className="w-full">
                  <SelectValue>{(v: RewardMetricValue) => REWARD_METRIC_LABELS[v]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {REWARD_METRIC_VALUES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {REWARD_METRIC_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-threshold">At least ({UNIT_HINT[REWARD_METRIC_UNIT[metric]]})</Label>
              <Input id="rule-threshold" type="number" inputMode="decimal" min={0} step="any" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-quality">Delivered at least (%)</Label>
              <Input id="rule-quality" type="number" inputMode="numeric" min={1} max={100} step={1} value={minRate} onChange={(e) => setMinRate(e.target.value)} placeholder="optional, e.g. 85" />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">The delivered floor keeps a month full of returns from earning the reward: delivered ÷ (delivered + returned).</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-amount">Reward (৳)</Label>
              <Input id="rule-amount" type="number" inputMode="decimal" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="3000" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-note">…and/or a note</Label>
              <Input id="rule-note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Day off of choice" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Switch id="rule-active" checked={active} onCheckedChange={setActive} />
            <Label htmlFor="rule-active">Active</Label>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              Save rule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
