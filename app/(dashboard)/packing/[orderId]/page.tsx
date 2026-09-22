import { notFound } from "next/navigation";

import { PackingOrderDetail } from "@/components/packing/packing-order-detail";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { loadPackingOrder, serializePackingOrderDetail } from "@/lib/packing/queue";
import { getPackingSlaHours } from "@/lib/settings/get";

export default async function PackingOrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const user = await guardPage("/packing");
  const { orderId } = await params;

  const [loaded, slaHours, canPack] = await Promise.all([
    loadPackingOrder(orderId),
    getPackingSlaHours(),
    can(user, "packing.pack"),
  ]);
  if (!loaded) notFound();

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-3xl md:p-6">
      <PackingOrderDetail order={serializePackingOrderDetail(loaded, slaHours)} canPack={canPack} />
    </div>
  );
}
