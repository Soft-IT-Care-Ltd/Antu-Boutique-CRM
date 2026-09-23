import { SectionHeader } from "@/components/finance/section-header";
import { CollectionReportView } from "@/components/reports/finance-reports";
import { monthStartInDhaka } from "@/lib/finance/dates";
import { getPaymentsAccess } from "@/lib/finance/page-context";
import { todayInDhaka } from "@/lib/inventory/constants";

export default async function CollectionReportPage() {
  const access = await getPaymentsAccess();
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <SectionHeader title="Payments & Wallets" description="Collection report — money received and refunded, by method, wallet, day and staff." links={access.links} />
      <CollectionReportView initialFrom={monthStartInDhaka()} initialTo={todayInDhaka()} />
    </div>
  );
}
