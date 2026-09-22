import Link from "next/link";
import { ClipboardList } from "lucide-react";

import { Button } from "@/components/ui/button";
import { OrderList } from "@/components/orders/order-list";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { scopedWhere } from "@/lib/auth/scope";

export default async function OrdersPage() {
  const user = await guardPage("/orders");
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
      <OrderList canCreate={canCreate} canFilterBySe={canFilterBySe} />
    </div>
  );
}
