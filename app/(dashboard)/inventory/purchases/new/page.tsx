import { redirect } from "next/navigation";

import { InventoryHeader } from "@/components/inventory/inventory-header";
import { PurchaseForm } from "@/components/inventory/purchase-form";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { listActableLocations } from "@/lib/locations/service";
import { prisma } from "@/lib/prisma";

export default async function NewPurchasePage() {
  const access = await getInventoryAccess();
  if (!access.canViewPurchases) redirect("/inventory");

  const [suppliers, locations] = await Promise.all([
    prisma.supplier.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    // C3 — only locations this person receives stock into.
    listActableLocations(prisma, access.user),
  ]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-5xl md:p-6">
      <InventoryHeader
        title="New purchase"
        description="Stock goes up at each line's location and weighted average cost is recalculated the moment you save."
        links={access.navLinks}
      />
      {locations.length === 0 ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          You aren&apos;t assigned to any stock location, so there&apos;s nowhere to receive a purchase. Ask an Admin to assign you in Settings → Locations.
        </p>
      ) : (
        <PurchaseForm suppliers={suppliers} locations={locations} />
      )}
    </div>
  );
}
