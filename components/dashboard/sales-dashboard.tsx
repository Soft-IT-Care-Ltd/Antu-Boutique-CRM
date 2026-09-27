import Link from "next/link";
import { Banknote, CalendarClock, CalendarDays, ClipboardEdit, PauseCircle, Repeat2, Undo2, Users } from "lucide-react";

import { AlertRow, CountBars, StatTile, TileGrid } from "@/components/dashboard/parts";
import { pct, QualityCell } from "@/components/targets/quality";
import { TargetGauge } from "@/components/targets/target-gauge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SessionUser } from "@/lib/auth/types";
import { leadsHref, ordersHref, returnsHref } from "@/lib/dashboard/links";
import type { DashboardPanels } from "@/lib/dashboard/panels";
import { getPendingApprovals, getSalesNumbers } from "@/lib/dashboard/sales";
import { LEAD_STATUS_LABELS } from "@/lib/leads/constants";
import { formatBDT } from "@/lib/money";
import { ORDER_STATUS_LABELS } from "@/lib/orders/constants";
import { prisma } from "@/lib/prisma";
import { targetViewLevel } from "@/lib/targets/http";
import { monthLabel } from "@/lib/targets/month";
import { getMyProgress, getTargetBoard } from "@/lib/targets/service";

// PRD §4.16 SE: my leads, my follow-ups due today, my orders by status, my
// target gauge, my this-month value — no cost, no profit, no other SE's
// data. TL: the team versions of the same, plus pending approvals.
// Every query below runs through the shared scope helper; the target board
// through target.view_* — so an executive's page can only hold their own.

export async function SalesDashboard({ user, panels, followUps }: { user: SessionUser; panels: DashboardPanels; followUps: React.ReactNode }) {
  const [numbers, approvals, level] = await Promise.all([getSalesNumbers(prisma, user), getPendingApprovals(prisma, user), targetViewLevel(user)]);
  const { ranges } = numbers;
  const team = level === "team" && user.teamId !== null;
  const [mine, board] = await Promise.all([
    panels.can.targets ? getMyProgress(prisma, user, ranges.month) : null,
    team ? getTargetBoard(prisma, user, "team", ranges.month) : null,
  ]);
  const teamProgress = board?.teams[0] ?? null;
  const my = team ? "Team" : "My";

  return (
    <div className="flex flex-col gap-6">
      <TileGrid className="xl:grid-cols-4">
        <StatTile label={`${my} value this month`} value={formatBDT(numbers.month.value)} href={ordersHref({ preset: "sales", range: ranges.mtdRange })} sub={`${numbers.month.orders} orders · ${monthLabel(ranges.month)}`} icon={CalendarDays} />
        <StatTile label="Today" value={formatBDT(numbers.today.value)} href={ordersHref({ preset: "sales", range: ranges.todayRange })} sub={`${numbers.today.orders} orders placed`} icon={Banknote} />
        {panels.can.leads ? <StatTile label={`${my} open leads`} value={numbers.leadsOpen} href={leadsHref({ status: "open" })} sub="still being worked" icon={Users} /> : null}
        <StatTile
          label="On hold"
          value={numbers.openOrders.find((o) => o.status === "ON_HOLD")?.count ?? 0}
          href={ordersHref({ status: "ON_HOLD" })}
          sub="orders waiting on something"
          icon={PauseCircle}
          tone={(numbers.openOrders.find((o) => o.status === "ON_HOLD")?.count ?? 0) > 0 ? "warning" : undefined}
        />
      </TileGrid>

      {approvals ? (
        <Card>
          <CardHeader>
            <CardTitle>Waiting for your approval</CardTitle>
            <CardDescription>Requests from {team ? "your team" : "your scope"} that can&apos;t go ahead until you decide.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-x-4 sm:grid-cols-2">
              {approvals.editRequests !== null ? <AlertRow icon={ClipboardEdit} label="Order edits" count={approvals.editRequests} href="/orders/edit-requests" active={approvals.editRequests > 0} /> : null}
              {approvals.returns !== null ? <AlertRow icon={Undo2} label="Returns" count={approvals.returns} href={returnsHref({ view: "requested", type: "RETURN" })} active={approvals.returns > 0} /> : null}
              {approvals.exchanges !== null ? <AlertRow icon={Repeat2} label="Exchanges" count={approvals.exchanges} href={returnsHref({ view: "requested", type: "EXCHANGE" })} active={approvals.exchanges > 0} /> : null}
              {approvals.leave !== null ? <AlertRow icon={CalendarClock} label="Leave requests" count={approvals.leave} href="/attendance/leave" active={approvals.leave > 0} /> : null}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {teamProgress ? (
          <Card>
            <CardHeader>
              <CardTitle>Team target this month</CardTitle>
              <CardDescription>{teamProgress.name} — orders placed by the team, cancelled and returned ones left out.</CardDescription>
              <CardAction>
                <Button variant="outline" size="sm" render={<Link href="/targets" />} nativeButton={false}>
                  Targets
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <TargetGauge progress={teamProgress} daysLeft={board!.daysLeft} />
            </CardContent>
          </Card>
        ) : null}
        {mine ? (
          <Card>
            <CardHeader>
              <CardTitle>My target this month</CardTitle>
              <CardDescription>Orders you placed — cancelled and returned ones left out.</CardDescription>
              <CardAction>
                <Button variant="outline" size="sm" render={<Link href="/targets/leaderboard" />} nativeButton={false}>
                  Leaderboard
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <TargetGauge progress={mine} daysLeft={mine.daysLeft} />
            </CardContent>
          </Card>
        ) : null}
        {board && board.people.length > 0 ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Team this month</CardTitle>
              <CardDescription>Each person&apos;s orders — click a name for their list.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col divide-y">
                {board.people.map((p) => (
                  <li key={p.userId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                    <Link href={ordersHref({ preset: "sales", createdById: p.userId, range: ranges.mtdRange })} className="min-w-0 flex-1 hover:underline">
                      <span className="block truncate text-sm font-medium">{p.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {p.stats.orderCount} orders{p.valueProgress !== null ? ` · ${pct(p.valueProgress)} of target` : ""}
                      </span>
                    </Link>
                    <QualityCell stats={p.stats} className="w-44" />
                    <Link href={ordersHref({ preset: "sales", createdById: p.userId, range: ranges.mtdRange })} className="w-28 text-right font-semibold tabular-nums hover:underline">
                      {formatBDT(p.stats.salesValue)}
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </div>

      {followUps}

      <div className="grid gap-4 lg:grid-cols-2">
        {panels.can.leads ? (
          <Card>
            <CardHeader>
              <CardTitle>{my} leads</CardTitle>
              <CardDescription>Open leads by stage.</CardDescription>
              <CardAction>
                <Button variant="outline" size="sm" render={<Link href="/leads" />} nativeButton={false}>
                  All leads
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <CountBars rows={numbers.leads.map((l) => ({ key: l.status, label: LEAD_STATUS_LABELS[l.status], count: l.count, href: leadsHref({ status: l.status }) }))} empty="No open leads." />
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>{my} orders by status</CardTitle>
            <CardDescription>In progress now, and how this month&apos;s orders ended.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <CountBars
              rows={numbers.openOrders.map((o) => ({ key: o.status, label: ORDER_STATUS_LABELS[o.status], count: o.count, href: ordersHref({ status: o.status }), tone: o.status === "ON_HOLD" ? ("danger" as const) : undefined }))}
            />
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium text-muted-foreground">Placed this month</p>
              <CountBars rows={numbers.closedThisMonth.map((o) => ({ key: o.status, label: ORDER_STATUS_LABELS[o.status], count: o.count, href: ordersHref({ status: o.status, range: ranges.mtdRange }) }))} />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
