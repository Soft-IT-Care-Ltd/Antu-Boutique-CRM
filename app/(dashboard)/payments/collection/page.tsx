import { z } from "zod";

import { SectionHeader } from "@/components/finance/section-header";
import { CollectionReportView } from "@/components/reports/finance-reports";
import { monthStartInDhaka } from "@/lib/finance/dates";
import { getPaymentsAccess } from "@/lib/finance/page-context";
import { todayInDhaka } from "@/lib/inventory/constants";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const filtersSchema = z.object({ from: z.string().regex(DAY).optional().catch(undefined), to: z.string().regex(DAY).optional().catch(undefined) });

export default async function CollectionReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await getPaymentsAccess();
  const filters = filtersSchema.parse(await searchParams);
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <SectionHeader title="Payments & Wallets" description="Collection report — money received and refunded, by method, wallet, day and staff." links={access.links} />
      <CollectionReportView key={JSON.stringify(filters)} initialFrom={filters.from ?? monthStartInDhaka()} initialTo={filters.to ?? todayInDhaka()} />
    </div>
  );
}
