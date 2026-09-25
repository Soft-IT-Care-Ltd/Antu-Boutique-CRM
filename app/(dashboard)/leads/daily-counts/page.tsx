import { DailyCountSheet } from "@/components/leads/daily-count-sheet";
import { LeadsHeader } from "@/components/leads/leads-header";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { todayInDhaka } from "@/lib/inventory/constants";
import { listCampaignSuggestions, listLeadPeople } from "@/lib/leads/queries";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// PRD §4.5 — bulk daily-count quick entry. An executive counts their own
// day; a team leader can count for their team, a manager for anyone.
export default async function DailyCountsPage() {
  const user = await guardPage("/leads");
  const [people, campaigns, canSave] = await Promise.all([listLeadPeople(prisma, user), listCampaignSuggestions(prisma, user), can(user, "lead.create")]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <LeadsHeader title="Daily counts" description="For busy days: record how many leads came in per source instead of one by one. They count towards conversion rates." />
      {people.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No one in your scope records leads, so there are no counts to enter.</p>
      ) : (
        <DailyCountSheet people={people} currentUserId={user.id} today={todayInDhaka()} campaigns={campaigns} canSave={canSave} />
      )}
    </div>
  );
}
