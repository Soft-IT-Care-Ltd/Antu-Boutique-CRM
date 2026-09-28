import { notFound, redirect } from "next/navigation";

import { TransferScreen } from "@/components/transfers/transfer-screen";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { prisma } from "@/lib/prisma";
import { getTransferView } from "@/lib/transfers/service";

// C4 — one transfer: scan out, scan in, resolve what went missing.
export default async function TransferPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await getInventoryAccess();
  if (!access.canViewTransfers) redirect("/inventory");
  const transfer = await getTransferView(prisma, access.user, (await params).id, { withCost: access.hasCostAccess });
  if (!transfer) notFound();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4 md:p-6">
      <TransferScreen initial={transfer} />
    </div>
  );
}
