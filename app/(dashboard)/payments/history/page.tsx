import { z } from "zod";

import { SectionHeader } from "@/components/finance/section-header";
import { PaymentList } from "@/components/payments/payment-list";
import { getPaymentsAccess } from "@/lib/finance/page-context";
import { prisma } from "@/lib/prisma";
import { listWalletOptions } from "@/lib/wallets/service";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const filtersSchema = z.object({ from: z.string().regex(DAY).optional().catch(undefined), to: z.string().regex(DAY).optional().catch(undefined) });

export default async function PaymentHistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await getPaymentsAccess();
  const filters = filtersSchema.parse(await searchParams);
  const wallets = await listWalletOptions(prisma);
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <SectionHeader title="Payments & Wallets" description="Every payment and refund, newest first." links={access.links} />
      <PaymentList key={JSON.stringify(filters)} initialFilters={filters} view="all" wallets={wallets} canVerify={access.canVerify} canDecideRefund={access.canDecideRefund} />
    </div>
  );
}
