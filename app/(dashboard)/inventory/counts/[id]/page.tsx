import { notFound, redirect } from "next/navigation";

import { StockCountScreen } from "@/components/stock-counts/stock-count-screen";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { prisma } from "@/lib/prisma";
import { getStockCountView } from "@/lib/stock-counts/service";

export default async function StockCountPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await getInventoryAccess();
  if (!access.canCount) redirect("/inventory");
  const count = await getStockCountView(prisma, access.user, (await params).id);
  if (!count) notFound();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4 md:p-6">
      <StockCountScreen initial={count} />
    </div>
  );
}
