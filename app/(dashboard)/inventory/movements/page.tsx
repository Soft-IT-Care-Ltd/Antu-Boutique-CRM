import { redirect } from "next/navigation";

import { InventoryHeader } from "@/components/inventory/inventory-header";
import { MovementList } from "@/components/inventory/movement-list";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { listLocations } from "@/lib/locations/service";
import { prisma } from "@/lib/prisma";

export default async function StockMovementsPage({ searchParams }: { searchParams: Promise<{ variantId?: string; locationId?: string; q?: string }> }) {
  const access = await getInventoryAccess();
  if (!access.canViewLedger) redirect("/inventory");

  const { variantId, locationId, q } = await searchParams;
  const [variant, locations] = await Promise.all([
    variantId ? prisma.productVariant.findUnique({ where: { id: variantId }, select: { id: true, sku: true } }) : null,
    listLocations(prisma),
  ]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <InventoryHeader
        title="Stock ledger"
        description="Every stock change, at every location, append-only. Corrections are new rows, never edits."
        links={access.navLinks}
      />
      <MovementList
        hasCostAccess={access.hasCostAccess}
        initialVariant={variant}
        locations={locations}
        initialLocationId={locations.some((l) => l.id === locationId) ? locationId! : "all"}
        initialQ={q ?? ""}
      />
    </div>
  );
}
