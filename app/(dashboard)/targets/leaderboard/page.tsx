import Link from "next/link";
import { z } from "zod";
import { Crown } from "lucide-react";

import { Meter, pct, QualityCell } from "@/components/targets/quality";
import { TargetsHeader } from "@/components/targets/targets-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { guardPage } from "@/lib/auth/guard-page";
import { formatBDT } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { LEADERBOARD_SORT_LABELS, LEADERBOARD_SORTS, type LeaderboardSort } from "@/lib/targets/constants";
import { monthLabel } from "@/lib/targets/month";
import { targetPageContext } from "@/lib/targets/page-context";
import { getLeaderboard } from "@/lib/targets/service";
import type { LeaderboardRow, StatsView, TeamLeaderboardRow } from "@/lib/targets/types";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const SORT_HINT: Record<LeaderboardSort, string> = {
  value: "Order value placed this month — cancelled and returned orders don't count.",
  delivered: "Only the orders that actually reached the customer — the measure returns can't inflate.",
  orders: "Number of orders placed — cancelled and returned ones don't count.",
};

const measure = (sort: LeaderboardSort, s: StatsView) => (sort === "orders" ? String(s.orderCount) : formatBDT(sort === "delivered" ? s.deliveredValue : s.salesValue));

// PRD §4.13 leaderboard: top sellers by value and by orders, with the
// delivered-vs-returned quality beside every row so volume alone can't win.
// An executive sees their own row and rank only — never anyone else's numbers.
export default async function LeaderboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await guardPage("/targets");
  const params = await searchParams;
  const { month, months, level } = await targetPageContext(user, Promise.resolve(params));
  const sort = z.enum(LEADERBOARD_SORTS).catch("value").parse(params.sort);
  const board = await getLeaderboard(prisma, user, level, month, sort);
  const me = board.rows.find((r) => r.isMe);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <TargetsHeader title="Leaderboard" description="Who's selling most this month — and how much of it stayed sold." month={month} months={months} />

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Rank by">
          {LEADERBOARD_SORTS.map((s) => (
            <Button key={s} size="sm" variant={s === sort ? "default" : "outline"} render={<Link href={`/targets/leaderboard?month=${month}&sort=${s}`} />} nativeButton={false}>
              {LEADERBOARD_SORT_LABELS[s]}
            </Button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">{SORT_HINT[sort]} Ties go to the better delivered rate.</p>
      </div>

      {level === "own" ? (
        me ? (
          <Card>
            <CardHeader>
              <CardTitle>
                You&apos;re #{me.rank} of {board.ranked}
              </CardTitle>
              <CardDescription>{monthLabel(month)}, by {LEADERBOARD_SORT_LABELS[sort].toLowerCase()}. Only your own numbers are shown.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-sm text-muted-foreground">{LEADERBOARD_SORT_LABELS[sort]}</p>
                <p className="text-2xl font-semibold tabular-nums">{measure(sort, me.stats)}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Of your value target</p>
                <p className="text-2xl font-semibold tabular-nums">{pct(me.valueProgress)}</p>
              </div>
              <QualityCell stats={me.stats} />
            </CardContent>
          </Card>
        ) : (
          <div className="rounded-lg border border-dashed py-16 text-center text-sm text-muted-foreground">The leaderboard ranks sales executives and team leaders.</div>
        )
      ) : (
        <>
          {board.teams.length > 1 ? <TeamTable rows={board.teams} sort={sort} /> : null}
          <Card>
            <CardHeader>
              <CardTitle>{level === "team" ? "Your team" : "Sales executives"}</CardTitle>
              <CardDescription>
                {monthLabel(month)} · {board.ranked} ranked{level === "team" ? " across the shop — ranks are shop-wide" : ""}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {board.rows.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">Nobody to rank yet.</p>
              ) : (
                <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12">#</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead className="text-right">{LEADERBOARD_SORT_LABELS[sort]}</TableHead>
                        <TableHead>Quality</TableHead>
                        <TableHead className="hidden w-40 md:table-cell">Value target</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {board.rows.map((r) => (
                        <PersonRow key={r.userId} r={r} sort={sort} />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function PersonRow({ r, sort }: { r: LeaderboardRow; sort: LeaderboardSort }) {
  return (
    <TableRow className={cn(r.isMe && "bg-muted/50")}>
      <TableCell className="font-medium tabular-nums">
        <span className="inline-flex items-center gap-1">
          {r.rank === 1 ? <Crown className="size-3.5" aria-label="Top" /> : null}
          {r.rank}
        </span>
      </TableCell>
      <TableCell>
        <span className="font-medium">{r.name}</span>
        {r.isMe ? <span className="text-muted-foreground"> (you)</span> : null}
        {r.teamName ? <span className="block text-xs text-muted-foreground">{r.teamName}</span> : null}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {measure(sort, r.stats)}
        <span className="block text-xs text-muted-foreground">{sort === "orders" ? formatBDT(r.stats.salesValue) : `${r.stats.orderCount} orders`}</span>
      </TableCell>
      <TableCell>
        <QualityCell stats={r.stats} />
      </TableCell>
      <TableCell className="hidden md:table-cell">
        {r.valueProgress === null ? (
          <span className="text-sm text-muted-foreground">No target</span>
        ) : (
          <div className="flex items-center gap-2">
            <Meter value={r.valueProgress} />
            <span className="w-11 shrink-0 text-right text-sm tabular-nums">{pct(r.valueProgress)}</span>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

function TeamTable({ rows, sort }: { rows: TeamLeaderboardRow[]; sort: LeaderboardSort }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Teams</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Team</TableHead>
              <TableHead className="text-right">{LEADERBOARD_SORT_LABELS[sort]}</TableHead>
              <TableHead>Quality</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((t) => (
              <TableRow key={t.teamId}>
                <TableCell className="tabular-nums">{t.rank}</TableCell>
                <TableCell className="font-medium">{t.name}</TableCell>
                <TableCell className="text-right tabular-nums">{measure(sort, t.stats)}</TableCell>
                <TableCell>
                  <QualityCell stats={t.stats} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
