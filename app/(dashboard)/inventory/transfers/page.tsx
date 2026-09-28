import { redirect } from "next/navigation";

import { InventoryHeader } from "@/components/inventory/inventory-header";
import { TransferList } from "@/components/transfers/transfer-list";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { listActableLocations, listLocations } from "@/lib/locations/service";
import { prisma } from "@/lib/prisma";

// C4 — CORRECTIONS.md item 3: every transfer from or to the person's
// locations (location.all: every one), by what still needs doing.
export default async function TransfersPage() {
  const access = await getInventoryAccess();
  if (!access.canViewTransfers) redirect("/inventory");
  const [locations, sendFrom] = await Promise.all([listLocations(prisma, { activeOnly: true }), access.canSendTransfers ? listActableLocations(prisma, access.user) : []]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <InventoryHeader title="Transfers" description="Stock moving between locations — scanned out at one end, scanned in at the other." links={access.navLinks} />
      <TransferList locations={locations} sendFrom={sendFrom} />
    </div>
  );
}
