import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { OrderList } from "@/components/orders/order-list";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { scopedWhere } from "@/lib/auth/scope";
import { ORDER_CHANNEL_VALUES, ORDER_STATUS_VALUES } from "@/lib/orders/constants";
import { ORDER_DATE_BASES, ORDER_LIST_PRESETS } from "@/lib/orders/list-presets";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Links from the dashboards land here pre-filtered (P4.3). Anything that
// doesn't parse is dropped; the API scopes whatever is left (rule 6).
const filtersSchema = z.object({
  status: z.enum(ORDER_STATUS_VALUES).optional().catch(undefined),
  channel: z.enum(ORDER_CHANNEL_VALUES).optional().catch(undefined),
  createdById: z.string().cuid().optional().catch(undefined),
  from: z.string().regex(DAY).optional().catch(undefined),
  to: z.string().regex(DAY).optional().catch(undefined),
  dateBy: z.enum(ORDER_DATE_BASES).optional().catch(undefined),
  preset: z.enum(ORDER_LIST_PRESETS).optional().catch(undefined),
});

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await guardPage("/orders");
  const filters = filtersSchema.parse(await searchParams);
  const [canCreate, canFilterBySe, canReviewEditRequests] = await Promise.all([
    can(user, "order.create"),
    can(user, ["order.view_team", "order.view_all"]),
    can(user, "order.edit_after_window"),
  ]);

  const pendingEditRequestCount = canReviewEditRequests
    ? await prisma.orderEditRequest.count({ where: { status: "PENDING", order: scopedWhere({ deletedAt: null }, user) } })
    : 0;

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
          <p className="text-sm text-muted-foreground">Lead to packed — the online order form, items, and reference images.</p>
        </div>
        {canReviewEditRequests ? (
          <Button render={<Link href="/orders/edit-requests" />} nativeButton={false} variant="outline">
            <ClipboardList />
            Edit requests
            {pendingEditRequestCount > 0 ? ` (${pendingEditRequestCount})` : ""}
          </Button>
        ) : null}
      </div>
      <OrderList key={JSON.stringify(filters)} canCreate={canCreate} canFilterBySe={canFilterBySe} initialFilters={filters} />
    </div>
  );
}
