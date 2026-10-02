import { notFound, redirect } from "next/navigation";

import { ShelfCountScreen } from "@/components/shelves/shelf-count-screen";
import { can } from "@/lib/auth/permissions";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { prisma } from "@/lib/prisma";
import { getShelfCountView } from "@/lib/shelves/service";

// C4b — counting one shelf by scan.
export default async function ShelfCountPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await getInventoryAccess();
  if (!(await can(access.user, "stock.count"))) redirect("/inventory");
  const count = await getShelfCountView(prisma, access.user, (await params).id);
  if (!count) notFound();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4 md:p-6">
      <ShelfCountScreen initial={count} />
    </div>
  );
}
