import { redirect } from "next/navigation";

import { OrderForm } from "@/components/orders/order-form";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import type { CourierCompanyOption } from "@/lib/orders/types";

export default async function NewOrderPage() {
  const user = await guardPage("/orders");
  if (!(await can(user, "order.create"))) redirect("/orders");

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

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-4xl md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New order</h1>
        <p className="text-sm text-muted-foreground">One person, their items, an optional photo, and the delivery details.</p>
      </div>
      <OrderForm hasCostAccess={hasCostAccess} canStockOverride={canStockOverride} couriers={courierOptions} />
    </div>
  );
}
