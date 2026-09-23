import { redirect } from "next/navigation";

import { InventoryHeader } from "@/components/inventory/inventory-header";
import { PurchaseForm } from "@/components/inventory/purchase-form";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { prisma } from "@/lib/prisma";

export default async function NewPurchasePage() {
  const access = await getInventoryAccess();
  if (!access.canViewPurchases) redirect("/inventory");

  const suppliers = await prisma.supplier.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } });

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-5xl md:p-6">
      <InventoryHeader
        title="New purchase"
        description="Stock goes up and weighted average cost is recalculated the moment you save."
        links={access.navLinks}
      />
      <PurchaseForm suppliers={suppliers} />
    </div>
  );
}
