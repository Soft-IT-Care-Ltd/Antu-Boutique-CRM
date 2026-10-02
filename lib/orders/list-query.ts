import "server-only";

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import { dayString } from "@/lib/finance/http";
import { paginationQuery } from "@/lib/list/pagination";
import { ORDER_CHANNEL_VALUES, ORDER_STATUS_VALUES } from "@/lib/orders/constants";
import { ORDER_DATE_BASES, ORDER_LIST_PRESETS } from "@/lib/orders/list-presets";
import { dateBasisWhere, dhakaDaysRange, orderTabWhere, presetWhere } from "@/lib/orders/list-where";
import { ORDER_SUB_TAB_KEYS, ORDER_TAB_BY_KEY, ORDER_TAB_KEYS, ORDER_TABS, type OrderTabCounts, type OrderTabKey } from "@/lib/orders/tabs";
import { settleIfPending } from "@/lib/fulfilment/settle";
import { prisma } from "@/lib/prisma";
import { getPackingSlaHours } from "@/lib/settings/get";

// The Orders list's filters (GET /api/orders and its tab counts), in one
// place so a tab's count and its rows are built from the same where. Every
// where is ANDed into the caller's scope (CLAUDE.md rule 6).

export const orderFiltersSchema = z.object({
  q: z.string().trim().optional(),
  // A narrowing status inside the tab (dashboard links).
  status: z.enum(ORDER_STATUS_VALUES).optional(),
  channel: z.enum(ORDER_CHANNEL_VALUES).optional(),
  createdById: z.string().cuid().optional(),
  // Dhaka calendar days, inclusive, read against `dateBy` (default: placed).
  from: dayString.optional(),
  to: dayString.optional(),
  dateBy: z.enum(ORDER_DATE_BASES).default("placed"),
  // P4.3 — the named slices the dashboards link to (lib/orders/list-presets.ts).
  preset: z.enum(ORDER_LIST_PRESETS).optional(),
});

export const orderListQuerySchema = orderFiltersSchema.extend({
  tab: z.enum(ORDER_TAB_KEYS).default("all"),
  sub: z.enum(ORDER_SUB_TAB_KEYS).optional(),
  ...paginationQuery,
});

export type OrderFilters = z.infer<typeof orderFiltersSchema>;

/**
 * Everything but the tab. `withDates` is false for open-work tabs: they
 * show every open order whatever the date filter says (item 14).
 */
async function baseConditions(f: OrderFilters, withDates: boolean): Promise<Prisma.OrderWhereInput[]> {
  const and: Prisma.OrderWhereInput[] = [{ deletedAt: null }];
  if (f.preset) and.push(presetWhere(f.preset, { packingSlaHours: f.preset === "stuck" ? await getPackingSlaHours() : 0, now: new Date() }));
  if (f.status) and.push({ status: f.status });
  if (f.channel) and.push({ channel: f.channel });
  // Client-sent createdById is safe: scopedWhere() ANDs the mandatory scope
  // clause in afterward, so an SE sending someone else's id gets zero rows.
  if (f.createdById) and.push({ createdById: f.createdById });
  if (withDates && (f.from || f.to)) and.push(dateBasisWhere(f.dateBy, dhakaDaysRange(f.from, f.to)));
  if (f.q) {
    and.push({
      OR: [
        { orderNo: { contains: f.q, mode: "insensitive" } },
        { customer: { name: { contains: f.q, mode: "insensitive" } } },
        { customer: { phone: { contains: f.q.replace(/[\s-]/g, "") } } },
      ],
    });
  }
  return and;
}

export async function orderListWhere(f: OrderFilters & { tab: OrderTabKey; sub?: (typeof ORDER_SUB_TAB_KEYS)[number] }, user: SessionUser): Promise<Prisma.OrderWhereInput> {
  const and = await baseConditions(f, !ORDER_TAB_BY_KEY[f.tab].open);
  and.push(orderTabWhere(f.tab, f.sub));
  return scopedWhere({ AND: and }, user) as Prisma.OrderWhereInput;
}

/** Every tab's and sub-tab's count under the same filters, in two grouped queries. */
export async function orderTabCounts(f: OrderFilters, user: SessionUser): Promise<OrderTabCounts> {
  // C5 — fulfilment statuses are current before they're counted.
  await settleIfPending(prisma);
  const [openBase, datedBase] = await Promise.all([baseConditions(f, false), baseConditions(f, true)]);
  const where = (and: Prisma.OrderWhereInput[], extra: Prisma.OrderWhereInput = {}) => scopedWhere({ AND: [...and, extra] }, user) as Prisma.OrderWhereInput;

  const [openRows, datedRows, approvalPending, waiting, needsTransfer] = await Promise.all([
    prisma.order.groupBy({ by: ["status"], where: where(openBase), _count: { _all: true } }),
    prisma.order.groupBy({ by: ["status"], where: where(datedBase), _count: { _all: true } }),
    prisma.order.count({ where: where(openBase, orderTabWhere("with_courier", "approval_pending")) }),
    prisma.order.count({ where: where(openBase, orderTabWhere("waiting_for_stock")) }),
    prisma.order.count({ where: where(openBase, orderTabWhere("needs_transfer")) }),
  ]);
  const sum = (rows: typeof openRows, statuses: readonly string[] | "all") =>
    rows.filter((r) => statuses === "all" || statuses.includes(r.status)).reduce((a, r) => a + r._count._all, 0);

  const tabs = {} as Record<OrderTabKey, number>;
  for (const t of ORDER_TABS) {
    tabs[t.key] = sum(t.open ? openRows : datedRows, t.statuses);
  }
  // C5 — the confirmed orders split three ways by fulfilment status.
  tabs.waiting_for_stock = waiting;
  tabs.needs_transfer = needsTransfer;
  tabs.ready_to_pack -= waiting + needsTransfer;
  const inTransit = sum(openRows, ["IN_TRANSIT"]);
  return {
    tabs,
    subTabs: {
      handed_over: sum(openRows, ["HANDED_TO_COURIER"]),
      in_transit: inTransit - approvalPending,
      approval_pending: approvalPending,
      returned: sum(datedRows, ["RETURNED", "REFUNDED"]),
      exchange: sum(datedRows, ["EXCHANGE_REQUESTED"]),
    },
  };
}
