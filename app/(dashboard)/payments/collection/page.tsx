import { SectionHeader } from "@/components/finance/section-header";
import { CollectionReportView } from "@/components/reports/finance-reports";
import { dateRangeFromParams } from "@/lib/date-range";
import { getPaymentsAccess } from "@/lib/finance/page-context";

export default async function CollectionReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await getPaymentsAccess();
  // A dashboard link's from/to lands on its preset (Today, This Month) or a custom range.
  const range = dateRangeFromParams(await searchParams, "this_month");
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <SectionHeader title="Payments & Wallets" description="Collection report — money received and refunded, by method, wallet, day and staff." links={access.links} />
      <CollectionReportView key={JSON.stringify(range)} initialRange={range} />
    </div>
  );
}
