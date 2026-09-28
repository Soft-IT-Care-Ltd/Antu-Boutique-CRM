import { CircleCheck, TriangleAlert } from "lucide-react";

import { InventoryHeader } from "@/components/inventory/inventory-header";
import { StockReport } from "@/components/inventory/stock-report";
import { findStockLedgerDivergences } from "@/lib/inventory/ledger";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { listActableLocations, listLocations } from "@/lib/locations/service";
import { prisma } from "@/lib/prisma";

export default async function InventoryPage() {
  const access = await getInventoryAccess();

  // Categories come from the server (not /api/catalog/categories) because
  // Packing holds inventory.view but not product.view.
  const [categories, divergences, locations, actableLocations] = await Promise.all([
    prisma.category.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true } }),
    access.canViewLedger ? findStockLedgerDivergences(prisma) : Promise.resolve(null),
    listLocations(prisma),
    access.canAdjust ? listActableLocations(prisma, access.user) : Promise.resolve([]),
  ]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <InventoryHeader title="Inventory" description="Stock per size and colour, at every location — on hand, reserved and available." links={access.navLinks} />

      {divergences === null ? null : divergences.length === 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleCheck className="size-3.5 text-emerald-600" />
          Ledger check: every variant&apos;s stock, at every location, equals the sum of its stock movements.
        </p>
      ) : (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <div>
            Stock and ledger disagree for {divergences.length} variant(s):{" "}
            {divergences.map((d) => `${d.sku}${d.locationName ? ` at ${d.locationName}` : ""} (stock ${d.stockQty}, ledger ${d.ledgerQty})`).join(", ")}. This should be impossible — report it.
          </div>
        </div>
      )}

      <StockReport
        categories={categories}
        canViewCatalog={access.canViewCatalog}
        hasCostAccess={access.hasCostAccess}
        canAdjust={access.canAdjust}
        canViewLedger={access.canViewLedger}
        locations={locations}
        actableLocations={actableLocations}
      />
    </div>
  );
}
