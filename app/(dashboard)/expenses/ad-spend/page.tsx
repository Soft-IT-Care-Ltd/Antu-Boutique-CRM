import { AdSpendView } from "@/components/expenses/ad-spend";
import { SectionHeader } from "@/components/finance/section-header";
import { getExpensesAccess } from "@/lib/finance/page-context";
import { prisma } from "@/lib/prisma";
import { listWalletOptions } from "@/lib/wallets/service";

export default async function AdSpendPage() {
  const access = await getExpensesAccess();
  const wallets = await listWalletOptions(prisma);
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <SectionHeader title="Expenses" description="Daily ad spend, spread over each day's confirmed orders for per-order profit." links={access.links} />
      <AdSpendView wallets={wallets} canCreate={access.canCreate} canEdit={access.canEdit} canDelete={access.canDelete} canSetAllocation={access.canSetAllocation} />
    </div>
  );
}
