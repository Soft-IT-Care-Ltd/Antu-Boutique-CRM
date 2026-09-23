import { redirect } from "next/navigation";

import { SectionHeader } from "@/components/finance/section-header";
import { WalletsOverview } from "@/components/wallets/wallets-overview";
import { getPaymentsAccess } from "@/lib/finance/page-context";

export default async function WalletsPage() {
  const access = await getPaymentsAccess();
  if (!access.canViewWallets) redirect("/payments");
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <SectionHeader
        title="Payments & Wallets"
        description="Balances are worked out from every verified payment, approved refund, expense, courier payout and manual entry."
        links={access.links}
      />
      <WalletsOverview canEntry={access.canWalletEntry} canManage={access.canManageWallets} />
    </div>
  );
}
