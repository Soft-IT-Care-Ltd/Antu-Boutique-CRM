import { notFound, redirect } from "next/navigation";

import { OrderForm } from "@/components/orders/order-form";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { scopedWhere } from "@/lib/auth/scope";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { prisma } from "@/lib/prisma";
import { DIRECTLY_EDITABLE_STATUSES } from "@/lib/orders/constants";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";
import type { CourierCompanyOption } from "@/lib/orders/types";
import type { OrderStatusValue } from "@/lib/orders/constants";

export default async function EditOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await guardPage("/orders");
  const { id } = await params;

  if (!(await can(user, "order.edit"))) redirect(`/orders/${id}`);

  const scopedRow = await prisma.order.findFirst({ where: scopedWhere({ id, deletedAt: null }, user), select: { id: true, status: true } });
  if (!scopedRow) notFound();
  if (!DIRECTLY_EDITABLE_STATUSES.includes(scopedRow.status as OrderStatusValue)) redirect(`/orders/${id}`);

  const loaded = await loadOrderDetail(id);
  if (!loaded) notFound();

  const [hasCostAccess, canStockOverride, couriers] = await Promise.all([
    can(user, "product.cost.view"),
    can(user, "order.stock_override"),
    prisma.courierCompany.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, include: { zones: { orderBy: { zone: "asc" } } } }),
  ]);

  const courierOptions: CourierCompanyOption[] = couriers.map((c) => ({
    id: c.id,
    name: c.name,
    zones: c.zones.map((z) => ({ id: z.id, zone: z.zone, charge: z.charge.toString() })),
  }));

  const order = await stripCostFieldsForUser(serializeOrderDetail(loaded), user);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-4xl md:p-6">
      <div>
        <h1 className="text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">Edit {order.orderNo}</h1>
        <p className="text-sm text-muted-foreground">Items, delivery, and money — the customer and photos are managed separately.</p>
      </div>
      <OrderForm order={order} hasCostAccess={hasCostAccess} canStockOverride={canStockOverride} couriers={courierOptions} />
    </div>
  );
}
