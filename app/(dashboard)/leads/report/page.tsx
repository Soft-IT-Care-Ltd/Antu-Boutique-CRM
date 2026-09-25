import { ConversionReportView } from "@/components/leads/conversion-report";
import { LeadsHeader } from "@/components/leads/leads-header";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { monthStartInDhaka } from "@/lib/finance/dates";
import { todayInDhaka } from "@/lib/inventory/constants";
import { listLeadPeople } from "@/lib/leads/queries";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// PRD §4.5 conversion-rate reporting per executive, source and campaign.
// Scoped like the lead list: an executive sees only their own numbers.
export default async function LeadReportPage() {
  const user = await guardPage("/leads");
  const [people, canExport] = await Promise.all([listLeadPeople(prisma, user), can(user, "report.export")]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <LeadsHeader title="Conversion" description="How many leads became orders — by sales executive, source and campaign." />
      <ConversionReportView people={people} canExport={canExport} monthStart={monthStartInDhaka()} today={todayInDhaka()} />
    </div>
  );
}
