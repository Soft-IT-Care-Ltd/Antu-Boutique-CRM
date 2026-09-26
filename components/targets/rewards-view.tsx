"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Calculator, Loader2, Pencil, Plus } from "lucide-react";

import { pct } from "@/components/targets/quality";
import { RewardRuleDialog } from "@/components/targets/reward-rule-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { REWARD_METRIC_LABELS, REWARD_METRIC_UNIT, REWARD_SCOPE_LABELS, type RewardMetricValue } from "@/lib/targets/constants";
import { monthLabel } from "@/lib/targets/month";
import type { MonthAwards, RewardRuleView } from "@/lib/targets/types";

function formatThreshold(metric: RewardMetricValue, value: string) {
  const unit = REWARD_METRIC_UNIT[metric];
  const n = Number(value);
  return unit === "money" ? formatBDT(n) : unit === "percent" ? `${n}%` : `${n} orders`;
}

const rewardText = (amount: string | null, note: string | null) => [amount ? formatBDT(amount) : null, note].filter(Boolean).join(" + ");

/** PRD §4.13 — the reward-rules table and a month's rewards, worked out at month end. */
export function RewardsView({ rules, awards, canManage, isClosedMonth }: { rules: RewardRuleView[]; awards: MonthAwards; canManage: boolean; isClosedMonth: boolean }) {
  const router = useRouter();
  const [evaluating, setEvaluating] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function evaluate() {
    setEvaluating(true);
    setMessage(null);
    try {
      const { awards: n } = await fetchJson<{ awards: number }>("/api/targets/rewards/evaluate", { method: "POST", body: JSON.stringify({ month: awards.month }) });
      setMessage({ ok: true, text: `Worked out — ${n} reward${n === 1 ? "" : "s"} earned.` });
      router.refresh();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Could not work out the rewards." });
    } finally {
      setEvaluating(false);
    }
  }

  const total = awards.awards.reduce((sum, a) => sum + (a.rewardAmount ? Number(a.rewardAmount) : 0), 0);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>
            {awards.preview ? `If ${monthLabel(awards.month)} ended today` : `${monthLabel(awards.month)} rewards`}
          </CardTitle>
          <CardDescription>
            {awards.preview
              ? isClosedMonth
                ? "This month is over but its rewards haven't been worked out yet — the month-end run does it, or work it out now."
                : "A live preview against today's orders. Rewards are worked out once the month is over."
              : `Worked out ${formatDhakaDateTime(awards.evaluatedAt!)} by ${awards.evaluatedBy}.`}
          </CardDescription>
          {canManage && isClosedMonth ? (
            <CardAction>
              <Button size="sm" variant={awards.preview ? "default" : "outline"} onClick={evaluate} disabled={evaluating}>
                {evaluating ? <Loader2 className="animate-spin" /> : <Calculator />}
                {awards.preview ? "Work out now" : "Work out again"}
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {message ? <p className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p> : null}
          {awards.awards.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{rules.some((r) => r.isActive) ? "No rewards earned." : "No active reward rules yet."}</p>
          ) : (
            <>
              <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Who</TableHead>
                      <TableHead>Rule</TableHead>
                      <TableHead className="text-right">Reached</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Delivered</TableHead>
                      <TableHead>Reward</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {awards.awards.map((a) => (
                      <TableRow key={`${a.ruleId}-${a.userId ?? a.teamId}`}>
                        <TableCell className="font-medium">
                          {a.subjectName}
                          {a.teamId ? <span className="block text-xs font-normal text-muted-foreground">team</span> : null}
                        </TableCell>
                        <TableCell>
                          {a.ruleName}
                          <span className="block text-xs text-muted-foreground">
                            {REWARD_METRIC_LABELS[a.metric]} ≥ {formatThreshold(a.metric, a.threshold)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatThreshold(a.metric, a.achieved)}</TableCell>
                        <TableCell className="hidden text-right tabular-nums sm:table-cell">{pct(a.deliveredRate)}</TableCell>
                        <TableCell>{rewardText(a.rewardAmount, a.rewardNote)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {total > 0 ? <p className="text-right text-sm">Cash rewards: <span className="font-semibold tabular-nums">{formatBDT(total)}</span></p> : null}
            </>
          )}
        </CardContent>
      </Card>

      <RewardRulesCard rules={rules} canManage={canManage} />
    </div>
  );
}

/** The reward-rules table with add/edit — on Targets → Rewards and in Settings (PRD §4.17). */
export function RewardRulesCard({ rules, canManage }: { rules: RewardRuleView[]; canManage: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState<RewardRuleView | "new" | null>(null);
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Reward rules</CardTitle>
          <CardDescription>Threshold → reward. Rules on the same measure are tiers: only the highest reached pays. A delivered floor stops returns from earning a reward.</CardDescription>
          {canManage ? (
            <CardAction>
              <Button size="sm" onClick={() => setEditing("new")}>
                <Plus />
                New rule
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent>
          {rules.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No reward rules yet.</p>
          ) : (
            <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rule</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead className="hidden sm:table-cell">Delivered floor</TableHead>
                    <TableHead>Reward</TableHead>
                    {canManage ? <TableHead className="w-12" /> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.map((r) => (
                    <TableRow key={r.id} className={r.isActive ? "" : "text-muted-foreground"}>
                      <TableCell className="font-medium">
                        {r.name}
                        <span className="block text-xs font-normal text-muted-foreground">{REWARD_SCOPE_LABELS[r.scope]}</span>
                        {!r.isActive ? <Badge variant="outline">Off</Badge> : null}
                      </TableCell>
                      <TableCell>
                        {REWARD_METRIC_LABELS[r.metric]} ≥ {formatThreshold(r.metric, r.threshold)}
                      </TableCell>
                      <TableCell className="hidden tabular-nums sm:table-cell">{r.minDeliveredRate ? `${r.minDeliveredRate}%` : "—"}</TableCell>
                      <TableCell>{rewardText(r.rewardAmount, r.rewardNote)}</TableCell>
                      {canManage ? (
                        <TableCell>
                          <Button size="icon-sm" variant="ghost" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}>
                            <Pencil />
                          </Button>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {editing ? (
        <RewardRuleDialog
          rule={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
