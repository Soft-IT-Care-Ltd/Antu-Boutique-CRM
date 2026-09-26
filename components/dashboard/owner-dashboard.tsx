import Link from "next/link";
import { AlertTriangle, BellRing, Boxes, Clock, HandCoins, Trophy, Truck } from "lucide-react";

import { ChannelSplitChart, ProfitTrendChart, ReturnsChart, SalesTrendChart } from "@/components/dashboard/owner-charts";
import { AlertRow, SectionTitle, StatTile, TileGrid } from "@/components/dashboard/parts";
import { Meter, pct } from "@/components/targets/quality";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SessionUser } from "@/lib/auth/types";
import { attendanceViewLevel } from "@/lib/attendance/http";
import { getTodayBoard } from "@/lib/attendance/sheet";
import { codHref, collectionHref, expensesHref, followUpsHref, leadsHref, ordersHref, profitHref, returnsHref, targetsHref, type DayRange } from "@/lib/dashboard/links";
import { COD_OVERDUE_DAYS, getLowStockSummary } from "@/lib/dashboard/operations";
import { getOwnerNumbers, type PeriodRow } from "@/lib/dashboard/owner";
import type { DashboardPanels } from "@/lib/dashboard/panels";
import { codOverdueSummary } from "@/lib/courier/cod-queries";
import { OPERATING_EXPENSE_FILTER } from "@/lib/expenses/constants";
import { listDueFollowUps } from "@/lib/leads/queries";
import { formatBDT, toNumber } from "@/lib/money";
import { ORDER_STATUS_LABELS } from "@/lib/orders/constants";
import { formatHours } from "@/lib/orders/list-presets";
import { paymentQueueCounts } from "@/lib/payments/queries";
import { prisma } from "@/lib/prisma";
import { targetViewLevel } from "@/lib/targets/http";
import { daysLeftInMonth, monthLabel } from "@/lib/targets/month";
import { getLeaderboard, getTargetBoard } from "@/lib/targets/service";
import type { Progress } from "@/lib/targets/types";

// PRD §4.16 Owner/Admin — "the owner sees the business in 10 seconds":
// today, month to date with target progress, the live operations funnel,
// the team, 30-day charts and what needs attention. Rendered only when
// dashboardPanels() says owner (report.pl.view + product.cost.view +
// order.view_all), because profit is on it.

function PeriodTiles({ row, range, label }: { row: PeriodRow; range: DayRange; label: string }) {
  const profit = toNumber(row.profit);
  return (
    <TileGrid>
      <StatTile label={`${label} orders`} value={row.orders} href={ordersHref({ preset: "sales", range })} sub="not cancelled or returned" />
      <StatTile label="Value" value={formatBDT(row.value)} href={ordersHref({ preset: "sales", range })} sub="order totals" />
      <StatTile label="Collected" value={formatBDT(row.collected)} href={collectionHref(range)} sub="money received" />
      <StatTile label="Due" value={formatBDT(row.due)} href={ordersHref({ preset: "due", range })} sub="still unpaid on these orders" tone={toNumber(row.due) > 0 ? "warning" : undefined} />
      <StatTile label="Expenses" value={formatBDT(row.expenses)} href={expensesHref(range, OPERATING_EXPENSE_FILTER)} sub="not counting stock bought" />
      <StatTile
        label="Profit"
        value={formatBDT(row.profit)}
        href={profitHref(range)}
        sub={`on ${formatBDT(row.revenueOut)} sent out (${row.ordersOut})`}
        tone={profit < 0 ? "danger" : undefined}
      />
    </TileGrid>
  );
}

/** Month to date against the sales floor's targets — teams' if any team has a value target, else each person's. */
function TargetStrip({ subjects, month, daysLeft }: { subjects: Progress[]; month: string; daysLeft: number }) {
  const withValue = subjects.filter((s) => s.target?.orderValue);
  if (withValue.length === 0) {
    return (
      <Link href={targetsHref(month)} className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground hover:bg-muted/40">
        No sales targets set for {monthLabel(month)} — set them on the Targets page.
      </Link>
    );
  }
  const goal = withValue.reduce((a, s) => a + toNumber(s.target!.orderValue!), 0);
  const achieved = withValue.reduce((a, s) => a + toNumber(s.stats.salesValue), 0);
  const ratio = goal > 0 ? achieved / goal : null;
  return (
    <Link href={targetsHref(month)} className="flex flex-col gap-2 rounded-xl border bg-card p-3 hover:bg-muted/40 sm:flex-row sm:items-center sm:gap-4 sm:p-4">
      <span className="flex items-center gap-2 text-sm font-medium">
        <Trophy className="size-4 text-muted-foreground" aria-hidden />
        Target progress
      </span>
      <Meter value={ratio} className="sm:flex-1" />
      <span className="text-sm tabular-nums">
        <span className="font-semibold">{formatBDT(achieved)}</span> <span className="text-muted-foreground">of</span> {formatBDT(goal)} — {pct(ratio)}
        <span className="text-muted-foreground">
          , {daysLeft} day{daysLeft === 1 ? "" : "s"} left
        </span>
      </span>
    </Link>
  );
}

function Funnel({ stages }: { stages: { label: string; count: number; href: string; hint: string }[] }) {
  const max = Math.max(1, ...stages.map((s) => s.count));
  return (
    <ol className="flex flex-col gap-1.5">
      {stages.map((s, i) => (
        <li key={s.label}>
          <Link href={s.href} className="flex items-center gap-3 rounded-md px-1.5 py-1 hover:bg-muted">
            <span className="w-28 shrink-0 text-sm">
              <span className="text-muted-foreground tabular-nums">{i + 1}.</span> {s.label}
              <span className="block text-xs text-muted-foreground">{s.hint}</span>
            </span>
            <span className="h-6 flex-1" aria-hidden>
              <span className="block h-full rounded-r-md bg-[var(--viz-online)]" style={{ width: `${Math.max(2, (s.count / max) * 100)}%`, opacity: 1 - i * 0.12 }} />
            </span>
            <span className="w-12 shrink-0 text-right text-lg font-semibold tabular-nums">{s.count}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

export async function OwnerDashboard({ user, panels }: { user: SessionUser; panels: DashboardPanels }) {
  const now = new Date();
  const [numbers, targetLevel, attendanceLevel] = await Promise.all([getOwnerNumbers(prisma, user, now), targetViewLevel(user), attendanceViewLevel(user)]);
  const { ranges } = numbers;
  const [board, leaderboard, attendance, lowStock, followUps, unverified, codLate] = await Promise.all([
    targetLevel ? getTargetBoard(prisma, user, targetLevel, ranges.month) : null,
    targetLevel ? getLeaderboard(prisma, user, targetLevel, ranges.month, "value") : null,
    attendanceLevel === "all" || attendanceLevel === "team" ? getTodayBoard(prisma, user, attendanceLevel, now) : null,
    panels.can.inventory ? getLowStockSummary() : null,
    panels.can.leads ? listDueFollowUps(prisma, user, { limit: 1, now }) : null,
    panels.can.payments ? paymentQueueCounts(user) : null,
    panels.can.cod ? codOverdueSummary(user, COD_OVERDUE_DAYS, now) : null,
  ]);
  const teamTargets = board?.teams.some((t) => t.target?.orderValue) ? board.teams : (board?.people ?? []);
  const present = attendance ? attendance.rows.filter((r) => r.state === "IN" || r.state === "OUT").length : 0;
  const expected = attendance ? attendance.rows.filter((r) => r.state !== "OFF" && r.state !== "LEAVE").length : 0;
  const late = attendance ? attendance.rows.filter((r) => r.record?.status === "LATE").length : 0;
  const stuckTotal = numbers.stuck.reduce((a, s) => a + s.count, 0);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <SectionTitle title="Today" description="Orders placed today, money in, and the profit on what went out." />
        <PeriodTiles row={numbers.today} range={ranges.todayRange} label="Today's" />
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle title={`${monthLabel(ranges.month)} so far`} />
        <PeriodTiles row={numbers.mtd} range={ranges.mtdRange} label="Month's" />
        {board ? <TargetStrip subjects={teamTargets} month={ranges.month} daysLeft={daysLeftInMonth(ranges.month, now)} /> : null}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Operations funnel</CardTitle>
            <CardDescription>Live — where everything is right now.</CardDescription>
          </CardHeader>
          <CardContent>
            <Funnel
              stages={[
                { label: "Leads", count: numbers.funnel.leadsOpen, href: leadsHref({ status: "open" }), hint: "being worked" },
                { label: "Confirmed", count: numbers.funnel.confirmed, href: ordersHref({ status: "CONFIRMED" }), hint: "to pack" },
                { label: "Packed", count: numbers.funnel.packed, href: ordersHref({ status: "PACKED" }), hint: "to hand over" },
                { label: "In transit", count: numbers.funnel.inTransit, href: ordersHref({ preset: "in_transit" }), hint: "with the courier" },
                { label: "Delivered", count: numbers.funnel.deliveredToday, href: ordersHref({ dateBy: "delivered", range: ranges.todayRange }), hint: "today" },
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
            <CardDescription>Red means something is waiting on someone.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col">
              {lowStock ? (
                <AlertRow
                  icon={Boxes}
                  label="Low stock"
                  count={lowStock.variants}
                  detail={lowStock.products > 0 ? `${lowStock.products} product${lowStock.products === 1 ? "" : "s"}${lowStock.out ? ` · ${lowStock.out} sizes/colours out` : ""}` : "Everything above its threshold"}
                  href="/inventory/low-stock"
                  active={lowStock.variants > 0}
                />
              ) : null}
              {followUps ? <AlertRow icon={BellRing} label="Overdue follow-ups" count={followUps.overdue} detail={`${followUps.dueToday} more due later today`} href={followUpsHref()} active={followUps.overdue > 0} /> : null}
              {unverified ? (
                <AlertRow icon={HandCoins} label="Unverified payments" count={unverified.unverified} detail={formatBDT(unverified.unverifiedAmount)} href="/payments" active={unverified.unverified > 0} />
              ) : null}
              {codLate ? (
                <AlertRow icon={Truck} label={`COD not received after ${COD_OVERDUE_DAYS} days`} count={codLate.count} detail={formatBDT(codLate.amount)} href={codHref({ overdue: true })} active={codLate.count > 0} />
              ) : null}
              <AlertRow
                icon={stuckTotal > 0 ? AlertTriangle : Clock}
                label="Orders stuck in one status"
                count={stuckTotal}
                detail={
                  stuckTotal > 0 ? (
                    <span className="flex flex-wrap gap-x-2">
                      {numbers.stuck.map((s) => (
                        <span key={s.status}>
                          {s.count} {ORDER_STATUS_LABELS[s.status].toLowerCase()} &gt; {formatHours(s.hours)}
                        </span>
                      ))}
                    </span>
                  ) : (
                    "Nothing sitting longer than it should"
                  )
                }
                href={ordersHref({ preset: "stuck" })}
                active={stuckTotal > 0}
              />
            </ul>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {leaderboard ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Leaderboard — top 5</CardTitle>
              <CardDescription>Order value this month, with how much of it was delivered.</CardDescription>
              <CardAction>
                <Button variant="outline" size="sm" render={<Link href="/targets/leaderboard" />} nativeButton={false}>
                  Full board
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              {leaderboard.rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No sales executives yet.</p>
              ) : (
                <ol className="flex flex-col">
                  {leaderboard.rows.slice(0, 5).map((r) => (
                    <li key={r.userId}>
                      <Link href={ordersHref({ preset: "sales", createdById: r.userId, range: ranges.mtdRange })} className="flex items-center gap-3 rounded-md px-1.5 py-1.5 hover:bg-muted">
                        <span className="w-6 shrink-0 text-sm text-muted-foreground tabular-nums">#{r.rank}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{r.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {r.stats.orderCount} orders · {pct(r.stats.deliveredRate)} delivered{r.valueProgress !== null ? ` · ${pct(r.valueProgress)} of target` : ""}
                          </span>
                        </span>
                        <span className="shrink-0 font-semibold tabular-nums">{formatBDT(r.stats.salesValue)}</span>
                      </Link>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        ) : null}
        {attendance ? (
          <Card>
            <CardHeader>
              <CardTitle>Attendance today</CardTitle>
              <CardDescription>Staff who checked in.</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/attendance" className="flex flex-col gap-1 rounded-md p-1.5 hover:bg-muted">
                <span className="text-3xl font-semibold tabular-nums">
                  {present}
                  <span className="text-lg font-normal text-muted-foreground"> of {expected}</span>
                </span>
                <span className="text-sm text-muted-foreground">
                  present{late ? ` · ${late} late` : ""}
                  {attendance.rows.some((r) => r.state === "LEAVE") ? ` · ${attendance.rows.filter((r) => r.state === "LEAVE").length} on leave` : ""}
                  {attendance.rows.some((r) => r.state === "ABSENT") ? ` · ${attendance.rows.filter((r) => r.state === "ABSENT").length} absent` : ""}
                </span>
              </Link>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <section className="flex flex-col gap-3">
        <SectionTitle title="Last 30 days" description="Click a bar to open that day." />
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Sales trend</CardTitle>
              <CardDescription>Order value placed each day, by channel.</CardDescription>
            </CardHeader>
            <CardContent>
              <SalesTrendChart days={numbers.days} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Channel split</CardTitle>
              <CardDescription>Online vs walk-in, 30 days.</CardDescription>
            </CardHeader>
            <CardContent>
              <ChannelSplitChart split={numbers.channel} range={ranges.chartRange} />
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Profit trend</CardTitle>
              <CardDescription>What went out each day, less its cost and that day&apos;s expenses.</CardDescription>
              <CardAction>
                <Button variant="outline" size="sm" render={<Link href={profitHref(ranges.chartRange)} />} nativeButton={false}>
                  {formatBDT(numbers.days.reduce((a, d) => a + d.profit, 0))}
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <ProfitTrendChart days={numbers.days} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Returns &amp; exchanges</CardTitle>
              <CardDescription>
                <Link href={returnsHref({ view: "report" })} className="underline-offset-4 hover:underline">
                  <span className="font-semibold text-foreground tabular-nums">{pct(numbers.returnRate.rate, 1)}</span> came back or were exchanged
                </Link>{" "}
                — {numbers.returnRate.comeBack} of {numbers.returnRate.reached} that reached a customer.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ReturnsChart days={numbers.days} />
            </CardContent>
          </Card>
        </div>
      </section>

      <p className="text-xs text-muted-foreground">
        Profit counts an order when it&apos;s packed (a walk-in sale when it&apos;s sold) — the day its cost is frozen — less that day&apos;s expenses, not counting stock bought.
      </p>
    </div>
  );
}
