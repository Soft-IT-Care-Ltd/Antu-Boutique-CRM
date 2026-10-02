import { redirect } from "next/navigation";

import { PutAwayScreen } from "@/components/shelves/put-away-screen";
import { can } from "@/lib/auth/permissions";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { canActAt, getLocationAccess } from "@/lib/locations/service";
import { prisma } from "@/lib/prisma";
import { listShelfLocations } from "@/lib/shelves/service";

// C4b — put away and move by scan, at one location.
export default async function PutAwayPage({ searchParams }: { searchParams: Promise<{ location?: string }> }) {
  const access = await getInventoryAccess();
  if (!(await can(access.user, "shelf.putaway"))) redirect("/inventory/shelves");
  const [locations, locationAccess] = await Promise.all([listShelfLocations(prisma, access.user), getLocationAccess(prisma, access.user)]);
  const wanted = (await searchParams).location;
  const location = locations.find((l) => l.id === wanted && canActAt(locationAccess, l.id)) ?? locations.find((l) => l.mine);
  if (!location) redirect("/inventory/shelves");
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4 md:p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Put away / move</h1>
      <PutAwayScreen location={{ id: location.id, name: location.name }} />
    </div>
  );
}
