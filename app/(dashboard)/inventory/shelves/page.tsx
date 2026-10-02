import Link from "next/link";
import { redirect } from "next/navigation";

import { InventoryHeader } from "@/components/inventory/inventory-header";
import { ShelvesScreen } from "@/components/shelves/shelves-screen";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { prisma } from "@/lib/prisma";
import { getShelfLocationView, listShelfLocations } from "@/lib/shelves/service";

// C4b — CORRECTIONS.md item 20A: the shelves inside a location.
export default async function ShelvesPage({ searchParams }: { searchParams: Promise<{ location?: string }> }) {
  const access = await getInventoryAccess();
  if (!access.canUseShelves) redirect("/inventory");
  const locations = await listShelfLocations(prisma, access.user);
  const wanted = (await searchParams).location;
  const location = locations.find((l) => l.id === wanted) ?? locations.find((l) => l.mine) ?? locations[0];
  const header = <InventoryHeader title="Shelves" description="Where each dress sits inside a location — put away by scan, count one shelf at a time." links={access.navLinks} />;
  if (!location) {
    return (
      <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
        {header}
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No location uses shelves. An Admin switches it on in <Link href="/settings/locations" className="underline">Settings → Locations</Link>.
        </p>
      </div>
    );
  }
  const view = await getShelfLocationView(prisma, access.user, location.id);
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      {header}
      <ShelvesScreen view={view} locations={locations} />
    </div>
  );
}
