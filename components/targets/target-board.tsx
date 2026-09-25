"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Copy, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import { TargetDialog, type TargetSubject } from "@/components/targets/target-dialog";
import { TargetGauge } from "@/components/targets/target-gauge";
import { Meter, pct, QualityCell } from "@/components/targets/quality";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBDT } from "@/lib/money";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { monthLabel } from "@/lib/targets/month";
import type { PersonProgress, TargetBoard, TargetGoal, TargetPerson, TargetTeam } from "@/lib/targets/types";

/**
 * PRD §4.13 — a month's targets with live progress: the viewer's own gauge,
 * each team's, and a row per person. target.manage sets, copies and
 * removes targets until the month's rewards are worked out.
 */
export function TargetBoardView({
  board,
  meId,
  canManage,
  people,
  teams,
}: {
  board: TargetBoard;
  meId: string;
  canManage: boolean;
  people: TargetPerson[];
  teams: TargetTeam[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<{ subject: TargetSubject | null; current: TargetGoal | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const editable = canManage && !board.locked;

  const me = board.people.find((p) => p.userId === meId);
  const others = board.people.length > 1 || board.teams.length > 0;

  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setMessage(null);
    try {
      setMessage({ ok: true, text: await fn() });
      router.refresh();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : "Something went wrong." });
    } finally {
      setBusy(null);
    }
  }

  const copy = () =>
    run("copy", async () => {
      const { copied } = await fetchJson<{ copied: number }>("/api/targets/copy", { method: "POST", body: JSON.stringify({ month: board.month }) });
      return copied ? `Copied ${copied} target${copied === 1 ? "" : "s"} from last month.` : "Everyone with a target last month already has one here.";
    });
  const remove = (goal: TargetGoal, name: string) =>
    run(goal.id, async () => {
      await fetchJson(`/api/targets/${goal.id}`, { method: "DELETE" });
      return `Removed ${name}'s target.`;
    });

  return (
    <div className="flex flex-col gap-4">
      {editable ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setEditing({ subject: null, current: null })}>
            <Plus />
            Set a target
          </Button>
          <Button size="sm" variant="outline" onClick={copy} disabled={busy !== null}>
            {busy === "copy" ? <Loader2 className="animate-spin" /> : <Copy />}
            Copy last month&apos;s
          </Button>
          {message ? <p className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>{message.text}</p> : null}
        </div>
      ) : board.locked && canManage ? (
        <p className="text-sm text-muted-foreground">{monthLabel(board.month)}&apos;s rewards have been worked out, so its targets are final.</p>
      ) : null}

      {me ? (
        <Card>
          <CardHeader>
            <CardTitle>My target</CardTitle>
            <CardDescription>{monthLabel(board.month)} — orders you placed, cancelled and returned ones left out.</CardDescription>
          </CardHeader>
          <CardContent>
            <TargetGauge progress={me} daysLeft={board.daysLeft} />
          </CardContent>
        </Card>
      ) : null}

      {board.teams.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {board.teams.map((t) => (
            <Card key={t.teamId}>
              <CardHeader>
                <CardTitle>{t.name}</CardTitle>
                <CardDescription>Team target — every order placed by the team.</CardDescription>
                {editable ? (
                  <CardAction>
                    <Button size="icon-sm" variant="ghost" onClick={() => setEditing({ subject: { kind: "team", id: t.teamId, name: t.name }, current: t.target })} aria-label={`Set ${t.name}'s target`}>
                      <Pencil />
                    </Button>
                  </CardAction>
                ) : null}
              </CardHeader>
              <CardContent>
                <TargetGauge progress={t} daysLeft={board.daysLeft} />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {others && board.people.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>People</CardTitle>
            <CardDescription>Sales executives and team leaders. Returned orders don&apos;t count toward value — they show under quality.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Order value</TableHead>
                    <TableHead className="w-44">Progress</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Orders</TableHead>
                    <TableHead className="hidden md:table-cell">Quality</TableHead>
                    {editable ? <TableHead className="w-20" /> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {board.people.map((p) => (
                    <PersonRow key={p.userId} p={p} editable={editable} busy={busy === p.target?.id} onEdit={() => setEditing({ subject: { kind: "user", id: p.userId, name: p.name }, current: p.target })} onRemove={() => p.target && remove(p.target, p.name)} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {!me && board.people.length === 0 && board.teams.length === 0 ? (
        <div className="rounded-lg border border-dashed py-16 text-center text-sm text-muted-foreground">No targets to show for {monthLabel(board.month)}.</div>
      ) : null}

      {editing ? (
        <TargetDialog
          month={board.month}
          subject={editing.subject}
          current={editing.current}
          people={people}
          teams={teams}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setMessage({ ok: true, text: "Target saved." });
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function PersonRow({ p, editable, busy, onEdit, onRemove }: { p: PersonProgress; editable: boolean; busy: boolean; onEdit: () => void; onRemove: () => void }) {
  const ratio = p.valueProgress ?? p.countProgress;
  return (
    <TableRow>
      <TableCell>
        <span className="font-medium">{p.name}</span>
        {p.teamName ? <span className="block text-xs text-muted-foreground">{p.teamName}</span> : null}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatBDT(p.stats.salesValue)}
        <span className="block text-xs text-muted-foreground">{p.target?.orderValue ? `of ${formatBDT(p.target.orderValue)}` : "no value target"}</span>
      </TableCell>
      <TableCell>
        {ratio === null ? (
          <span className="text-sm text-muted-foreground">No target</span>
        ) : (
          <div className="flex items-center gap-2">
            <Meter value={ratio} />
            <span className="w-11 shrink-0 text-right text-sm tabular-nums">{pct(ratio)}</span>
          </div>
        )}
      </TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">
        {p.stats.orderCount}
        {p.target?.orderCount ? <span className="text-muted-foreground"> / {p.target.orderCount}</span> : null}
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <QualityCell stats={p.stats} />
      </TableCell>
      {editable ? (
        <TableCell>
          <div className="flex justify-end gap-1">
            <Button size="icon-sm" variant="ghost" onClick={onEdit} aria-label={`Set ${p.name}'s target`}>
              <Pencil />
            </Button>
            {p.target ? (
              <Button size="icon-sm" variant="ghost" onClick={onRemove} disabled={busy} aria-label={`Remove ${p.name}'s target`}>
                {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
              </Button>
            ) : null}
          </div>
        </TableCell>
      ) : null}
    </TableRow>
  );
}
