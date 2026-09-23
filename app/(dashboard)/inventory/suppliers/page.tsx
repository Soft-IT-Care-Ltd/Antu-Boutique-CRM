import { redirect } from "next/navigation";

import { InventoryHeader } from "@/components/inventory/inventory-header";
import { SupplierManager } from "@/components/inventory/supplier-manager";
import { getInventoryAccess } from "@/lib/inventory/page-context";

export default async function SuppliersPage() {
  const access = await getInventoryAccess();
  if (!access.canViewPurchases) redirect("/inventory");

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <InventoryHeader title="Suppliers" description="Who you buy from, and what you still owe them." links={access.navLinks} />
      <SupplierManager />
    </div>
  );
}
