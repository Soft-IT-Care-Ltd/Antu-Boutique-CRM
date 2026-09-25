import { z } from "zod";

import { LeadList } from "@/components/leads/lead-list";
import { LeadsHeader } from "@/components/leads/leads-header";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { LEAD_FOLLOW_UP_FILTERS, LEAD_SOURCE_VALUES, LEAD_STATUS_VALUES } from "@/lib/leads/constants";
import { listCampaignSuggestions, listLeadPeople } from "@/lib/leads/queries";
import { prisma } from "@/lib/prisma";

// Links from the dashboard and the conversion report land here pre-filtered.
const filtersSchema = z.object({
  status: z.enum([...LEAD_STATUS_VALUES, "open", "all"]).optional().catch(undefined),
  source: z.enum(LEAD_SOURCE_VALUES).optional().catch(undefined),
  followUp: z.enum(LEAD_FOLLOW_UP_FILTERS).optional().catch(undefined),
  ownerId: z.string().cuid().optional().catch(undefined),
  campaign: z.string().trim().max(100).optional().catch(undefined),
});

// PRD §4.5 — leads, scoped server-side: an executive sees their own, a
// team leader their team's (lib/auth/scope.ts via /api/leads).
export default async function LeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await guardPage("/leads");
  const [canCreate, people, campaigns] = await Promise.all([can(user, "lead.create"), listLeadPeople(prisma, user), listCampaignSuggestions(prisma, user)]);
  const filters = filtersSchema.parse(await searchParams);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <LeadsHeader title="Leads" description="Every enquiry from Messenger, WhatsApp, ads and the showroom — until it becomes an order or is lost." />
      <LeadList canCreate={canCreate} people={people} campaigns={campaigns} initialFilters={filters} />
    </div>
  );
}
