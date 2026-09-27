import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { DrawerReconciliation } from "@/components/pos/drawer-reconciliation";
import { Button } from "@/components/ui/button";
import { guardPage } from "@/lib/auth/guard-page";
import { getDrawerSummary } from "@/lib/pos/drawer";
import { prisma } from "@/lib/prisma";

// One day's cash reconciliation, read-only.
export default async function DrawerDayPage({ params }: { params: Promise<{ id: string }> }) {
  await guardPage("/pos/drawer");
  const { id } = await params;
  const drawer = await getDrawerSummary(prisma, id);
  if (!drawer) notFound();

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <div>
        <Button render={<Link href="/pos/drawer" />} nativeButton={false} variant="ghost" className="-ml-2 mb-1">
          <ChevronLeft />
          Cash drawer
        </Button>
        <h1 className="text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">Cash reconciliation</h1>
      </div>
      <DrawerReconciliation drawer={drawer} />
    </div>
  );
}
