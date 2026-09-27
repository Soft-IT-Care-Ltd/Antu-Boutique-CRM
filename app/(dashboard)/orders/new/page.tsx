import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { OrderForm, type LeadPrefill } from "@/components/orders/order-form";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import { prisma } from "@/lib/prisma";
import type { CourierCompanyOption } from "@/lib/orders/types";
import { listWalletOptions } from "@/lib/wallets/service";

/**
 * P4.1 — ?leadId= opens the form pre-filled from a lead the user can see
 * and convert (PRD §4.5). Its customer is used only if the user can see
 * that customer too; otherwise the lead's name and phone are filled in.
 */
async function loadLeadPrefill(user: SessionUser, leadId: string): Promise<LeadPrefill> {
  if (!z.string().cuid().safeParse(leadId).success || !(await can(user, "lead.convert"))) notFound();
  const lead = await prisma.lead.findFirst({ where: scopedWhere({ id: leadId, deletedAt: null }, user), include: { order: { select: { id: true } } } });
  if (!lead) notFound();
  if (lead.status === "CONVERTED") redirect(lead.order ? `/orders/${lead.order.id}` : `/leads/${lead.id}`);

  const customer = lead.customerId
    ? await prisma.customer.findFirst({
        where: scopedWhere({ id: lead.customerId, deletedAt: null }, user),
        select: { id: true, name: true, phone: true, altPhone: true, division: true, district: true, thana: true, addressDetail: true },
      })
    : null;
  return { id: lead.id, name: lead.name, phone: lead.phone, source: lead.source, interest: lead.interest, customer };
}

export default async function NewOrderPage({ searchParams }: { searchParams: Promise<{ leadId?: string }> }) {
  const user = await guardPage("/orders");
  if (!(await can(user, "order.create"))) redirect("/orders");
  const { leadId } = await searchParams;

  const [hasCostAccess, canStockOverride, couriers, wallets, lead] = await Promise.all([
    can(user, "product.cost.view"),
    can(user, "order.stock_override"),
    prisma.courierCompany.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, include: { zones: { orderBy: { zone: "asc" } } } }),
    listWalletOptions(prisma),
    leadId ? loadLeadPrefill(user, leadId) : Promise.resolve(undefined),
  ]);

  const courierOptions: CourierCompanyOption[] = couriers.map((c) => ({
    id: c.id,
    name: c.name,
    zones: c.zones.map((z) => ({ id: z.id, zone: z.zone, charge: z.charge.toString() })),
  }));

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-4xl md:p-6">
      <div>
        <h1 className="text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">New order</h1>
        <p className="text-sm text-muted-foreground">One person, their items, an optional photo, and the delivery details.</p>
      </div>
      <OrderForm lead={lead} hasCostAccess={hasCostAccess} canStockOverride={canStockOverride} couriers={courierOptions} wallets={wallets} />
    </div>
  );
}
