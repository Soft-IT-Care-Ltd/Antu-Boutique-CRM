import Link from "next/link";

import { DueFollowUpList } from "@/components/leads/due-follow-ups";
import { LeadsHeader } from "@/components/leads/leads-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { followUpState } from "@/lib/leads/dates";
import { listDueFollowUps, listLeadPeople } from "@/lib/leads/queries";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// PRD §4.5 — every open follow-up for the next week, overdue first and in
// red. The dashboard shows today's; this is the full picture.
export default async function FollowUpsPage() {
  const user = await guardPage("/leads");
  const [due, canEdit, people] = await Promise.all([listDueFollowUps(prisma, user, { days: 7, limit: 300 }), can(user, "lead.edit"), listLeadPeople(prisma, user)]);
  const showOwner = people.length > 1;
  const now = new Date();
  const overdue = due.items.filter((f) => followUpState(f.dueAt, now) === "overdue");
  const today = due.items.filter((f) => followUpState(f.dueAt, now) === "today");
  const upcoming = due.items.filter((f) => followUpState(f.dueAt, now) === "upcoming");

  const sections = [
    { key: "overdue", title: "Overdue", count: due.overdue, items: overdue, empty: "Nothing overdue — well done.", tone: "text-destructive" },
    { key: "today", title: "Later today", count: due.dueToday, items: today, empty: "Nothing else due today.", tone: "" },
    { key: "upcoming", title: "Next 7 days", count: due.upcoming, items: upcoming, empty: "Nothing scheduled for the coming week.", tone: "" },
  ];

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <LeadsHeader title="Follow-ups" description="Who to get back to, and when. Mark each one done with what happened — and set the next one if needed." />
      <div className="grid gap-4 lg:grid-cols-3">
        {sections.map((s) => (
          <Card key={s.key}>
            <CardHeader>
              <CardTitle className={s.tone}>
                {s.title} <span className="tabular-nums text-muted-foreground">{s.count}</span>
              </CardTitle>
              {s.items.length < s.count ? (
                <CardDescription>
                  Showing the first {s.items.length}.{" "}
                  <Link href={`/leads?followUp=${s.key}`} className="underline-offset-4 hover:underline">
                    See all in Leads
                  </Link>
                </CardDescription>
              ) : null}
            </CardHeader>
            <CardContent>
              <DueFollowUpList items={s.items} showOwner={showOwner} canEdit={canEdit} emptyText={s.empty} />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
