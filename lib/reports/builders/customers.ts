import "server-only";

import type { Prisma } from "@prisma/client";

import { scopedWhere } from "@/lib/auth/scope";
import { CUSTOMER_TAG_LABELS, RISK_FLAG_REFUSED_COD_THRESHOLD } from "@/lib/customers/constants";
import { toPaisa } from "@/lib/inventory/costing";
import { NOT_COUNTED_AS_SALE } from "@/lib/orders/list-presets";
import { RETURNED_STATUSES } from "@/lib/targets/constants";
import { dayLabel, dhakaDay, figure, money, taka, narrowOrders, orderScope, ratio, type BuildContext, type BuiltReport } from "@/lib/reports/shared";

// R12 Customer (PRD §4.15): top customers by value, repeat rate, and
// customers flagged as a risk. Everything is counted over the orders the
// user can see — an executive's report is their own sales to their own
// customers, never another executive's (CLAUDE.md rule 6).

const TOP_N = 50;

export async function buildCustomersReport(ctx: BuildContext): Promise<BuiltReport> {
  const f = ctx.filters;
  const saleWhere: Prisma.OrderWhereInput = { deletedAt: null, exchangedFromOrderId: null, status: { notIn: NOT_COUNTED_AS_SALE }, ...narrowOrders(f) };
  const orders = await ctx.db.order.findMany({
    where: orderScope(ctx.user, { ...saleWhere, createdAt: { gte: f.from, lt: f.to } }),
    select: { customerId: true, total: true, createdAt: true, customer: { select: { name: true, phone: true, tags: true } } },
  });

  type Buyer = { name: string; phone: string; tags: string[]; orders: number; paisa: number; last: Date };
  const buyers = new Map<string, Buyer>();
  let anonymous = 0;
  let anonymousPaisa = 0;
  let total = 0;
  for (const o of orders) {
    const paisa = toPaisa(o.total);
    total += paisa;
    if (!o.customerId || !o.customer) {
      anonymous += 1;
      anonymousPaisa += paisa;
      continue;
    }
    const b = buyers.get(o.customerId) ?? { name: o.customer.name, phone: o.customer.phone, tags: o.customer.tags, orders: 0, paisa: 0, last: o.createdAt };
    b.orders += 1;
    b.paisa += paisa;
    if (o.createdAt > b.last) b.last = o.createdAt;
    buyers.set(o.customerId, b);
  }

  const ids = [...buyers.keys()];
  // Bought before the period (the same visibility), to tell new from returning.
  const earlier = ids.length
    ? await ctx.db.order.groupBy({ by: ["customerId"], where: orderScope(ctx.user, { ...saleWhere, customerId: { in: ids }, createdAt: { lt: f.from } }), _count: { _all: true } })
    : [];
  const earlierCount = new Map(earlier.map((e) => [e.customerId!, e._count._all]));
  const returning = ids.filter((id) => (earlierCount.get(id) ?? 0) > 0).length;
  const repeat = ids.filter((id) => (earlierCount.get(id) ?? 0) > 0 || buyers.get(id)!.orders >= 2).length;

  // Risk: tagged "Problem customer", or the courier brought 3+ of their
  // parcels back (refused COD — PRD §4.4). Lifetime, over visible orders.
  const riskOrders = await ctx.db.order.findMany({
    where: orderScope(ctx.user, {
      deletedAt: null,
      customerId: { not: null },
      ...narrowOrders(f),
      customer: { deletedAt: null, ...(scopedWhere({}, ctx.user) as Prisma.CustomerWhereInput) },
      OR: [{ customer: { tags: { has: "PROBLEM_CUSTOMER" } } }, { returnInspections: { some: { source: "COURIER_RETURN" } } }],
    }),
    select: {
      customerId: true,
      status: true,
      total: true,
      customer: { select: { name: true, phone: true, tags: true } },
      returnInspections: { where: { source: "COURIER_RETURN" }, select: { id: true } },
    },
  });
  type Risk = { id: string; name: string; phone: string; tags: string[]; refused: number; returned: number; orders: number };
  const risk = new Map<string, Risk>();
  for (const o of riskOrders) {
    const r = risk.get(o.customerId!) ?? { id: o.customerId!, name: o.customer!.name, phone: o.customer!.phone, tags: o.customer!.tags, refused: 0, returned: 0, orders: 0 };
    r.orders += 1;
    r.refused += o.returnInspections.length > 0 ? 1 : 0;
    if ((RETURNED_STATUSES as readonly string[]).includes(o.status)) r.returned += 1;
    risk.set(o.customerId!, r);
  }
  const flagged = [...risk.values()].filter((r) => r.tags.includes("PROBLEM_CUSTOMER") || r.refused >= RISK_FLAG_REFUSED_COD_THRESHOLD);
  const tagText = (tags: string[]) => tags.map((t) => CUSTOMER_TAG_LABELS[t as keyof typeof CUSTOMER_TAG_LABELS] ?? t).join(", ");

  const top = [...buyers.entries()].sort(([, a], [, b]) => b.paisa - a.paisa).slice(0, TOP_N);
  const named = total - anonymousPaisa;

  return {
    figures: [
      figure("Customers who bought", buyers.size, "int"),
      figure("Repeat rate", ratio(repeat, buyers.size), "percent", { hint: `${repeat} bought more than once` }),
      figure("Returning", returning, "int", { hint: "had bought before the period" }),
      figure("New", buyers.size - returning, "int"),
      figure("Avg per customer", buyers.size > 0 ? money(Math.round(named / buyers.size)) : null, "money"),
      figure("Risk-flagged", flagged.length, "int"),
    ],
    tables: [
      {
        id: "top",
        title: `Top ${TOP_N} customers by value`,
        columns: [
          { key: "name", label: "Customer" },
          { key: "phone", label: "Phone" },
          { key: "tags", label: "Tags" },
          { key: "orders", label: "Orders", format: "int" },
          { key: "value", label: "Value", format: "money" },
          { key: "share", label: "Share", format: "percent" },
          { key: "before", label: "Earlier orders", format: "int" },
          { key: "last", label: "Last order" },
        ],
        rows: top.map(([id, b]) => ({ name: b.name, phone: b.phone, tags: tagText(b.tags), orders: b.orders, value: money(b.paisa), share: ratio(b.paisa, total), before: earlierCount.get(id) ?? 0, last: dayLabel(dhakaDay(b.last)), _href: `/customers/${id}` })),
        empty: "No customer bought in this period.",
      },
      {
        id: "risk",
        title: "Risk-flagged customers",
        description: `Tagged "Problem customer", or ${RISK_FLAG_REFUSED_COD_THRESHOLD}+ parcels the courier brought back (refused COD). All time.`,
        columns: [
          { key: "name", label: "Customer" },
          { key: "phone", label: "Phone" },
          { key: "tags", label: "Tags" },
          { key: "refused", label: "Refused parcels", format: "int" },
          { key: "returned", label: "Fully returned", format: "int" },
        ],
        rows: flagged
          .sort((a, b) => b.refused - a.refused || a.name.localeCompare(b.name))
          .map((r) => ({ name: r.name, phone: r.phone, tags: tagText(r.tags), refused: r.refused, returned: r.returned, _href: `/customers/${r.id}` })),
        empty: "No risk-flagged customers.",
      },
    ],
    notes: [
      "Sales placed in the period (not cancelled, fully returned or an exchange's replacement).",
      `Repeat rate = customers who bought more than once — twice in the period, or before it too — ÷ customers who bought.${anonymous > 0 ? ` ${anonymous} walk-in sales (${taka(anonymousPaisa)}) had no customer record and aren't counted per customer.` : ""}`,
    ],
  };
}
