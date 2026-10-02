import { notFound, redirect } from "next/navigation";

import { ShelfDetail } from "@/components/shelves/shelf-detail";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { prisma } from "@/lib/prisma";
import { getShelfView } from "@/lib/shelves/service";

// C4b — one shelf.
export default async function ShelfPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await getInventoryAccess();
  if (!access.canUseShelves) redirect("/inventory");
  const shelf = await getShelfView(prisma, access.user, (await params).id);
  if (!shelf) notFound();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4 md:p-6">
      <ShelfDetail shelf={shelf} />
    </div>
  );
}
