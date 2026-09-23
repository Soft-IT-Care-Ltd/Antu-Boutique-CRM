import { SectionHeader } from "@/components/finance/section-header";
import { PaymentList } from "@/components/payments/payment-list";
import { getPaymentsAccess } from "@/lib/finance/page-context";
import { prisma } from "@/lib/prisma";
import { listWalletOptions } from "@/lib/wallets/service";

export default async function PaymentHistoryPage() {
  const access = await getPaymentsAccess();
  const wallets = await listWalletOptions(prisma);
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <SectionHeader title="Payments & Wallets" description="Every payment and refund, newest first." links={access.links} />
      <PaymentList view="all" wallets={wallets} canVerify={access.canVerify} canDecideRefund={access.canDecideRefund} />
    </div>
  );
}
