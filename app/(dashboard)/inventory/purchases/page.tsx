import { redirect } from "next/navigation";

import { InventoryHeader } from "@/components/inventory/inventory-header";
import { PurchaseList } from "@/components/inventory/purchase-list";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { prisma } from "@/lib/prisma";

export default async function PurchasesPage({ searchParams }: { searchParams: Promise<{ supplierId?: string }> }) {
  const access = await getInventoryAccess();
  if (!access.canViewPurchases) redirect("/inventory");

  const { supplierId } = await searchParams;
  const suppliers = await prisma.supplier.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <InventoryHeader title="Purchases" description="Stock bought in — each line updates the variant's weighted average cost." links={access.navLinks} />
      <PurchaseList suppliers={suppliers} initialSupplierId={suppliers.some((s) => s.id === supplierId) ? supplierId! : null} />
    </div>
  );
}
