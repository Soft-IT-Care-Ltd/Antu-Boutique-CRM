import { notFound, redirect } from "next/navigation";

import { SectionHeader } from "@/components/finance/section-header";
import { WalletStatementView } from "@/components/wallets/wallet-statement";
import { getPaymentsAccess } from "@/lib/finance/page-context";
import { prisma } from "@/lib/prisma";

export default async function WalletStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await getPaymentsAccess();
  if (!access.canViewWallets) redirect("/payments");
  const { id } = await params;
  const wallet = await prisma.wallet.findUnique({ where: { id }, select: { id: true } });
  if (!wallet) notFound();
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <SectionHeader title="Payments & Wallets" description="Wallet statement — every line that moved its balance." links={access.links} />
      <WalletStatementView walletId={id} initialRange={{ preset: "this_month" }} canVoid={access.canWalletEntry} />
    </div>
  );
}
