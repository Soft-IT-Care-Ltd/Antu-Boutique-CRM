import { redirect } from "next/navigation";

import { InventoryHeader } from "@/components/inventory/inventory-header";
import { HubNeedsScreen } from "@/components/transfers/hub-needs-screen";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { listActableLocations } from "@/lib/locations/service";
import { prisma } from "@/lib/prisma";

// C4 — CORRECTIONS.md item 3: per location, the waiting online orders whose
// dresses the packing hub doesn't have but this location does.
export default async function HubNeedsPage({ searchParams }: { searchParams: Promise<{ locationId?: string }> }) {
  const access = await getInventoryAccess();
  if (!access.canSendTransfers) redirect("/inventory");
  const mine = (await listActableLocations(prisma, access.user)).filter((l) => !l.isPackingHub);
  const { locationId } = await searchParams;
  const initial = mine.find((l) => l.id === locationId)?.id ?? mine[0]?.id ?? null;

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <InventoryHeader
        title="Needed at the packing hub"
        description="Online orders waiting to be packed whose dresses are here, not at the hub. Tick them and send them over in one transfer."
        links={access.navLinks}
      />
      <HubNeedsScreen locations={mine} initialLocationId={initial} />
    </div>
  );
}
