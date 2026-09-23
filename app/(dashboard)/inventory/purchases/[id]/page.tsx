import { notFound, redirect } from "next/navigation";

import { InventoryHeader } from "@/components/inventory/inventory-header";
import { PurchaseDetail } from "@/components/inventory/purchase-detail";
import { stripCostFields } from "@/lib/auth/strip-cost-fields";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { getPurchaseDetail } from "@/lib/inventory/queries";

export default async function PurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await getInventoryAccess();
  if (!access.canViewPurchases) redirect("/inventory");

  const { id } = await params;
  const purchase = await getPurchaseDetail(id);
  if (!purchase) notFound();

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <InventoryHeader title="Purchase" description="What came in, what it cost landed, and how it moved average cost." links={access.navLinks} />
      <PurchaseDetail initial={stripCostFields(purchase, access.hasCostAccess)} />
    </div>
  );
}
