import { PackingQueue } from "@/components/packing/packing-queue";
import { guardPage } from "@/lib/auth/guard-page";

export default async function PackingPage() {
  await guardPage("/packing");

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Packing queue</h1>
        <p className="text-sm text-muted-foreground">Confirmed orders, oldest first. Match against the reference photo, check quality, then mark packed.</p>
      </div>
      <PackingQueue />
    </div>
  );
}
