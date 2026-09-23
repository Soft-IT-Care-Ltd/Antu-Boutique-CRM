import { redirect } from "next/navigation";

import { InventoryHeader } from "@/components/inventory/inventory-header";
import { MovementList } from "@/components/inventory/movement-list";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { prisma } from "@/lib/prisma";

export default async function StockMovementsPage({ searchParams }: { searchParams: Promise<{ variantId?: string }> }) {
  const access = await getInventoryAccess();
  if (!access.canViewLedger) redirect("/inventory");

  const { variantId } = await searchParams;
  const variant = variantId ? await prisma.productVariant.findUnique({ where: { id: variantId }, select: { id: true, sku: true } }) : null;

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <InventoryHeader
        title="Stock ledger"
        description="Every stock change, append-only. Corrections are new rows, never edits."
        links={access.navLinks}
      />
      <MovementList hasCostAccess={access.hasCostAccess} initialVariant={variant} />
    </div>
  );
}
