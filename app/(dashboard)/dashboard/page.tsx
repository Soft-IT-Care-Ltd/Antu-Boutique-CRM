import Link from "next/link";

import { CheckInCard } from "@/components/attendance/check-in-card";
import { AccountsDashboard, CounterDashboard, PackingDashboard } from "@/components/dashboard/operations-dashboards";
import { OwnerDashboard } from "@/components/dashboard/owner-dashboard";
import { SalesDashboard } from "@/components/dashboard/sales-dashboard";
import { DueFollowUpList } from "@/components/leads/due-follow-ups";
import { UrlDateRangeFilter } from "@/components/list/url-date-range-filter";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/types";
import { getMyDay } from "@/lib/attendance/sheet";
import { dashboardPanels } from "@/lib/dashboard/panels";
import { dashboardPeriod } from "@/lib/dashboard/ranges";
import { dateRangeFromParams } from "@/lib/date-range";
import { followUpsHref } from "@/lib/dashboard/links";
import { listDueFollowUps, listLeadPeople } from "@/lib/leads/queries";
import { prisma } from "@/lib/prisma";
import { reportAllTimeFrom } from "@/lib/reports/filters";
import { formatDhakaDate } from "@/lib/inventory/constants";

export const dynamic = "force-dynamic";

/**
 * PRD §4.5 / §4.16 — "my follow-ups due today" with overdue ones first and
 * in red. Scoped: an executive's own, a team leader's team's.
 */
async function FollowUpsDueCard({ user }: { user: SessionUser }) {
  const [due, canEdit, people] = await Promise.all([listDueFollowUps(prisma, user, { limit: 15 }), can(user, "lead.edit"), listLeadPeople(prisma, user)]);
  const mine = people.length <= 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{mine ? "My follow-ups due today" : "Follow-ups due today"}</CardTitle>
        <CardDescription>
          <Link href={followUpsHref()} className={due.overdue > 0 ? "font-medium text-destructive underline-offset-4 hover:underline" : "underline-offset-4 hover:underline"}>
            {due.overdue} overdue
          </Link>
          {" · "}
          <Link href={followUpsHref()} className="underline-offset-4 hover:underline">
            {due.dueToday} later today
          </Link>
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" render={<Link href="/leads/follow-ups" />} nativeButton={false}>
            All follow-ups
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <DueFollowUpList items={due.items} showOwner={!mine} canEdit={canEdit} emptyText="Nothing due today. New reminders show up here on the day they're due." />
        {due.items.length < due.overdue + due.dueToday ? (
          <p className="pt-2 text-sm text-muted-foreground">
            Showing {due.items.length} of {due.overdue + due.dueToday}.{" "}
            <Link href="/leads/follow-ups" className="underline-offset-4 hover:underline">
              See them all
            </Link>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** PRD §4.14 check-in / check-out, one tap from the dashboard. */
async function CheckInDashboardCard({ user }: { user: SessionUser }) {
  const me = await getMyDay(prisma, user.id);
  if (!me.onRoster) return null;
  return <CheckInCard record={me.record} hours={me.hours} dayKind={me.dayKind} leaveToday={me.leaveToday} />;
}

// PRD §4.16 — one dashboard per job, picked by permission
// (lib/dashboard/panels.ts): the owner's whole-shop view with profit, the
// sales view (an executive's own, a team leader's team), Packing's queue
// and Accounts' money. Every number links to the list it summarises.
export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await guardPage("/dashboard");
  // CORRECTIONS.md item 16 — one date filter for every period figure on the page (This Month by default).
  const range = dateRangeFromParams(await searchParams, "this_month");
  const [panels, allTimeFrom] = await Promise.all([dashboardPanels(user), range.preset === "all" ? reportAllTimeFrom(prisma) : undefined]);
  const period = dashboardPeriod(range, allTimeFrom);
  const nothing = !panels.owner && !panels.sales && !panels.packing && !panels.accounts && !panels.counter;

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">Dashboard</h1>
          <p className="text-sm text-muted-foreground">{formatDhakaDate(new Date())} · click any number to see what&apos;s behind it.</p>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <UrlDateRangeFilter value={range} />
          <p className="text-xs text-muted-foreground">Live counts, queues and alerts are always as of now.</p>
        </div>
      </div>

      {panels.can.attendanceMark ? <CheckInDashboardCard user={user} /> : null}

      {panels.owner ? <OwnerDashboard user={user} panels={panels} period={period} /> : null}
      {panels.sales ? <SalesDashboard user={user} panels={panels} period={period} followUps={panels.can.leads ? <FollowUpsDueCard user={user} /> : null} /> : null}
      {panels.packing ? <PackingDashboard panels={panels} /> : null}
      {panels.accounts ? <AccountsDashboard user={user} panels={panels} period={period} /> : null}
      {panels.counter ? <CounterDashboard user={user} period={period} /> : null}

      {nothing ? <div className="rounded-lg border border-dashed py-16 text-center text-sm text-muted-foreground">Nothing to show for this account yet — use the menu to get to your work.</div> : null}
    </div>
  );
}
