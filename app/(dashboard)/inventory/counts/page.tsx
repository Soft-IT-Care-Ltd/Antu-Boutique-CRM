import { redirect } from "next/navigation";

import { InventoryHeader } from "@/components/inventory/inventory-header";
import { StockCountList } from "@/components/stock-counts/stock-count-list";
import { can } from "@/lib/auth/permissions";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { listActableLocations } from "@/lib/locations/service";
import { prisma } from "@/lib/prisma";

// C4 — CORRECTIONS.md item 2: count a location by scanning everything on the shelves.
export default async function StockCountsPage() {
  const access = await getInventoryAccess();
  if (!access.canCount) redirect("/inventory");
  const [mine, mayCount] = await Promise.all([listActableLocations(prisma, access.user), can(access.user, "stock.count")]);
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <InventoryHeader title="Stock counts" description="Scan what's really on the shelf; the difference from the system is posted as a stock adjustment." links={access.navLinks} />
      <StockCountList locations={mine} canStart={mayCount} />
    </div>
  );
}
