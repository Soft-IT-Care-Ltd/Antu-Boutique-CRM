import { z } from "zod";

import { PackingQueue } from "@/components/packing/packing-queue";
import { guardPage } from "@/lib/auth/guard-page";
import { PACKING_VIEWS } from "@/lib/packing/types";

export default async function PackingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await guardPage("/packing");
  const view = z.enum(PACKING_VIEWS).catch("queue").parse((await searchParams).view);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Packing queue</h1>
        <p className="text-sm text-muted-foreground">Confirmed orders, oldest first. Match against the reference photo, check quality, then mark packed.</p>
      </div>
      <PackingQueue key={view} view={view} />
    </div>
  );
}
