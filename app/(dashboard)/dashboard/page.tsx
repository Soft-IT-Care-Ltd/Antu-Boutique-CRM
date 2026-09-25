import Link from "next/link";
import { BarChart3, PackageCheck, ShoppingBag, Wallet } from "lucide-react";

import { CheckInCard } from "@/components/attendance/check-in-card";
import { DueFollowUpList } from "@/components/leads/due-follow-ups";
import { TargetGauge } from "@/components/targets/target-gauge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/types";
import { getMyDay } from "@/lib/attendance/sheet";
import { LEAD_VIEW_PERMISSIONS } from "@/lib/leads/http";
import { listDueFollowUps, listLeadPeople } from "@/lib/leads/queries";
import { formatBDT } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { TARGET_VIEW_PERMISSIONS } from "@/lib/targets/http";
import { getMyProgress } from "@/lib/targets/service";

const statCards = [
  { label: "Today's orders", value: "0", icon: ShoppingBag },
  { label: "Today's collection", value: formatBDT(0), icon: Wallet },
  { label: "In packing queue", value: "0", icon: PackageCheck },
  { label: "This month", value: formatBDT(0), icon: BarChart3 },
];

export const dynamic = "force-dynamic";

/**
 * PRD §4.5 / §4.16 — "my follow-ups due today" with overdue ones first and
 * in red. Scoped: an executive's own, a team leader's team's. The rest of
 * the role dashboards land in P4.3.
 */
async function FollowUpsDueCard({ user }: { user: SessionUser }) {
  const [due, canEdit, people] = await Promise.all([listDueFollowUps(prisma, user, { limit: 15 }), can(user, "lead.edit"), listLeadPeople(prisma, user)]);
  const mine = people.length <= 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{mine ? "My follow-ups due today" : "Follow-ups due today"}</CardTitle>
        <CardDescription>
          <Link href="/leads?followUp=overdue" className={due.overdue > 0 ? "font-medium text-destructive underline-offset-4 hover:underline" : "underline-offset-4 hover:underline"}>
            {due.overdue} overdue
          </Link>
          {" · "}
          <Link href="/leads?followUp=today" className="underline-offset-4 hover:underline">
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

/** PRD §4.13 "live progress gauge on the SE dashboard" — the viewer's own month. */
async function MyTargetCard({ user }: { user: SessionUser }) {
  const mine = await getMyProgress(prisma, user);
  if (!mine) return null;
  return (
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
  );
}

/** PRD §4.14 check-in / check-out, one tap from the dashboard. */
async function CheckInDashboardCard({ user }: { user: SessionUser }) {
  const me = await getMyDay(prisma, user.id);
  if (!me.onRoster) return null;
  return <CheckInCard record={me.record} hours={me.hours} dayKind={me.dayKind} leaveToday={me.leaveToday} />;
}

export default async function DashboardPage() {
  const user = await guardPage("/dashboard");
  const [seesLeads, seesTargets, marksAttendance] = await Promise.all([can(user, LEAD_VIEW_PERMISSIONS), can(user, TARGET_VIEW_PERMISSIONS), can(user, "attendance.mark")]);
  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          The owner&apos;s 10-second view of the business — live once Phase 1 lands.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statCards.map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {stat.label}
              </CardTitle>
              <stat.icon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {marksAttendance ? <CheckInDashboardCard user={user} /> : null}
      {seesTargets ? <MyTargetCard user={user} /> : null}
      {seesLeads ? <FollowUpsDueCard user={user} /> : null}

      <Card className="border-dashed">
        <CardHeader>
          <CardTitle>No data yet</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Seed data and the sales engine land in Phase 1. This screen wires up the real
          numbers — leads → orders → packed → delivered — and the 30-day charts once
          there is something to show.
        </CardContent>
      </Card>
    </div>
  );
}
