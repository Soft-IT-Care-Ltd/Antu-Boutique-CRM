import { notFound } from "next/navigation";

import { CustomerDetail } from "@/components/customers/customer-detail";
import { StoreCreditCard } from "@/components/customers/store-credit-card";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { scopedWhere } from "@/lib/auth/scope";
import { CUSTOMER_TAG_VALUES } from "@/lib/customers/constants";
import type { CustomerTagValue } from "@/lib/customers/constants";
import { computeCustomerStats } from "@/lib/customers/stats";
import { prisma } from "@/lib/prisma";
import { getStoreCreditSummary } from "@/lib/store-credit/ledger";

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await guardPage("/customers");
  const { id } = await params;

  const row = await prisma.customer.findFirst({
    where: scopedWhere({ id, deletedAt: null }, user),
    include: { createdBy: { select: { id: true, name: true } } },
  });
  if (!row) notFound();

  const [stats, canEdit, canDelete, storeCredit, canAdjustCredit] = await Promise.all([
    computeCustomerStats(row.id),
    can(user, "customer.edit"),
    can(user, "customer.delete"),
    getStoreCreditSummary(prisma, row.id),
    can(user, "customer.credit.adjust"),
  ]);

  const customer = {
    id: row.id,
    name: row.name,
    phone: row.phone,
    altPhone: row.altPhone,
    division: row.division,
    district: row.district,
    thana: row.thana,
    addressDetail: row.addressDetail,
    notes: row.notes,
    tags: row.tags.filter((t): t is CustomerTagValue => (CUSTOMER_TAG_VALUES as readonly string[]).includes(t)),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stats,
  };

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-4xl md:p-6">
      <CustomerDetail customer={customer} canEdit={canEdit} canDelete={canDelete} />
      <StoreCreditCard customerId={customer.id} initial={storeCredit} canAdjust={canAdjustCredit} />
    </div>
  );
}
