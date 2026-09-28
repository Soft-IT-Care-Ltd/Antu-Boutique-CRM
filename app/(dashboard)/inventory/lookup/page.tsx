import { InventoryHeader } from "@/components/inventory/inventory-header";
import { StockLookup } from "@/components/inventory/stock-lookup";
import { getInventoryAccess } from "@/lib/inventory/page-context";

// CORRECTIONS.md item 2 — stock lookup: scan, SKU or name → every location.
export default async function StockLookupPage() {
  const access = await getInventoryAccess();
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <InventoryHeader title="Stock lookup" description="Scan a tag or search — how many are at each location, in transit, reserved and available." links={access.navLinks} />
      <StockLookup />
    </div>
  );
}
