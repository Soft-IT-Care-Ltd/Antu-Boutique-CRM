import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { OrderList, type OrderListInitialFilters } from "@/components/orders/order-list";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { scopedWhere } from "@/lib/auth/scope";
import { ORDER_CHANNEL_VALUES, ORDER_STATUS_VALUES } from "@/lib/orders/constants";
import { ORDER_DATE_BASES, ORDER_LIST_PRESETS } from "@/lib/orders/list-presets";
import { ORDER_SUB_TAB_KEYS, ORDER_TAB_BY_KEY, ORDER_TAB_KEYS, tabForStatus } from "@/lib/orders/tabs";
import { dateRangeFromParams } from "@/lib/date-range";

// Links from the dashboards land here pre-filtered (P4.3). Anything that
// doesn't parse is dropped; the API scopes whatever is left (rule 6).
const filtersSchema = z.object({
  tab: z.enum(ORDER_TAB_KEYS).optional().catch(undefined),
  sub: z.enum(ORDER_SUB_TAB_KEYS).optional().catch(undefined),
  status: z.enum(ORDER_STATUS_VALUES).optional().catch(undefined),
  channel: z.enum(ORDER_CHANNEL_VALUES).optional().catch(undefined),
  createdById: z.string().cuid().optional().catch(undefined),
  dateBy: z.enum(ORDER_DATE_BASES).optional().catch(undefined),
  preset: z.enum(ORDER_LIST_PRESETS).optional().catch(undefined),
});

/**
 * CORRECTIONS.md item 14 — which tab and dates the list opens on. A link
 * naming a status opens that status's tab; "with the courier" opens With
 * courier. A link with a status or preset but no dates means "all of them",
 * so it opens on All Time; otherwise finished tabs default to This Month.
 */
function initialFilters(params: Record<string, string | string[] | undefined>): OrderListInitialFilters {
  const f = filtersSchema.parse(params);
  const fromStatus = f.status ? tabForStatus(f.status) : null;
  const tab = f.tab ?? fromStatus?.tab ?? (f.preset === "in_transit" ? "with_courier" : "all");
  const sub = f.tab ? f.sub : fromStatus?.sub;
  const range = dateRangeFromParams(params, f.status || f.preset ? "all" : "this_month");
  // The status only narrows when it's narrower than the tab it opened.
  const tabStatuses = ORDER_TAB_BY_KEY[tab].statuses;
  const status = f.status && (tabStatuses === "all" || tabStatuses.length > 1) && !sub ? f.status : undefined;
  return { tab, sub, range, status, channel: f.channel, createdById: f.createdById, dateBy: f.dateBy, preset: f.preset };
}

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await guardPage("/orders");
  const params = await searchParams;
  const filters = initialFilters(params);
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
          <h1 className="text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">Orders</h1>
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
