import { Boxes } from "lucide-react";

import { PlaceholderPage } from "@/components/app-shell/placeholder-page";
import { guardPage } from "@/lib/auth/guard-page";

export default async function InventoryPage() {
  await guardPage("/inventory");
  return (
    <PlaceholderPage
      title="Inventory"
      description="Purchases, weighted-average cost and the stock movement ledger."
      icon={Boxes}
      phase="Phase 2"
    />
  );
}
