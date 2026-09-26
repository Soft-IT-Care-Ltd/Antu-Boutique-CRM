import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { reviveCustomer } from "@/lib/trash/service";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { isValidBdPhone, normalizeBdPhone } from "@/lib/customers/phone";
import { toNumber } from "@/lib/money";
import { assertLeadConvertible, LeadError, markLeadConverted } from "@/lib/leads/service";
import { generateOrderInvoice } from "@/lib/orders/invoice";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";
import { generateOrderNumber } from "@/lib/orders/order-number";
import { isPriceBelowFloor } from "@/lib/orders/price-floor";
import { ORDER_LIST_INCLUDE, serializeOrderListItem } from "@/lib/orders/serialize";
import { reserveVariantStock } from "@/lib/orders/stock";
import { computeDueAmount, computeOrderTotals } from "@/lib/orders/totals";
import { ORDER_CHANNEL_VALUES, ORDER_STATUS_VALUES, PAYMENT_METHOD_VALUES } from "@/lib/orders/constants";
import { transactionIdSchema } from "@/lib/orders/payment-validation";
import { ORDER_DATE_BASES, ORDER_LIST_PRESETS } from "@/lib/orders/list-presets";
import { dateBasisWhere, dhakaDaysRange, presetWhere } from "@/lib/orders/list-where";
import { dayString } from "@/lib/finance/http";
import { getPackingSlaHours } from "@/lib/settings/get";
import type { PermissionKey } from "@/lib/auth/permission-definitions";
import { resolveSetLines, writeSetLines, type ResolvedSetLine } from "@/lib/sets/order-lines";
import { SetError } from "@/lib/sets/service";
import { setLineSchema } from "@/lib/sets/validation";
import { spendStoreCredit, StoreCreditError } from "@/lib/store-credit/ledger";
import { resolvePaymentWalletId, WalletError } from "@/lib/wallets/service";

const VIEW_PERMISSIONS: PermissionKey[] = ["order.view_own", "order.view_team", "order.view_all"];

const querySchema = z.object({
  q: z.string().trim().optional(),
  status: z.enum(ORDER_STATUS_VALUES).optional(),
  channel: z.enum(ORDER_CHANNEL_VALUES).optional(),
  createdById: z.string().cuid().optional(),
  // Dhaka calendar days, inclusive, read against `dateBy` (default: placed).
  from: dayString.optional(),
  to: dayString.optional(),
  dateBy: z.enum(ORDER_DATE_BASES).default("placed"),
  // P4.3 — the named slices the dashboards link to (lib/orders/list-presets.ts).
  preset: z.enum(ORDER_LIST_PRESETS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission(VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  }
  const { q, status, channel, createdById, from, to, dateBy, preset, page, pageSize } = parsed.data;

  const andConditions: Prisma.OrderWhereInput[] = [{ deletedAt: null }];
  if (preset) andConditions.push(presetWhere(preset, { packingSlaHours: preset === "stuck" ? await getPackingSlaHours() : 0, now: new Date() }));
  if (status) andConditions.push({ status });
  if (channel) andConditions.push({ channel });
  // Client-sent createdById is safe here: scopedWhere() ANDs the mandatory
  // scope clause in afterward, so an SE sending someone else's id just gets
  // zero rows back, never a wider result (CLAUDE.md rule 6).
  if (createdById) andConditions.push({ createdById });
  if (from || to) andConditions.push(dateBasisWhere(dateBy, dhakaDaysRange(from, to)));
  if (q) {
    andConditions.push({
      OR: [
        { orderNo: { contains: q, mode: "insensitive" } },
        { customer: { name: { contains: q, mode: "insensitive" } } },
        { customer: { phone: { contains: q.replace(/[\s-]/g, "") } } },
      ],
    });
  }

  const where: Prisma.OrderWhereInput = scopedWhere({ AND: andConditions }, guard.user);

  const [total, sums, orders] = await Promise.all([
    prisma.order.count({ where }),
    // Shown under the list so a dashboard figure can be checked against it.
    prisma.order.aggregate({ where, _sum: { total: true, dueAmount: true } }),
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: ORDER_LIST_INCLUDE,
    }),
  ]);

  return NextResponse.json({
    items: orders.map(serializeOrderListItem),
    total,
    totalValue: (sums._sum.total ?? 0).toString(),
    totalDue: (sums._sum.dueAmount ?? 0).toString(),
    page,
    pageSize,
  });
}

const orderItemSchema = z.object({
  variantId: z.string().cuid(),
  qty: z.coerce.number().int().min(1).max(9999),
  unitPrice: z.coerce.number().min(0),
  lineDiscount: z.coerce.number().min(0).default(0),
  stockOverrideReason: z.string().trim().max(300).optional(),
});

const newCustomerSchema = z.object({
  name: z.string().trim().min(1).max(150),
  phone: z.string().trim().min(1),
  altPhone: z.string().trim().max(20).nullish(),
  division: z.string().trim().max(60).nullish(),
  district: z.string().trim().max(60).nullish(),
  thana: z.string().trim().max(60).nullish(),
  addressDetail: z.string().trim().max(500).nullish(),
});

// P3.2 — STORE_CREDIT pays from the customer's store credit (no wallet,
// no TrxID; lib/store-credit/ledger.ts), never more than the order total.
const advancePaymentSchema = z.object({
  method: z.enum([...PAYMENT_METHOD_VALUES, "STORE_CREDIT"]),
  amount: z.coerce.number().positive(),
  walletId: z.string().trim().min(1).max(50).optional(),
  transactionId: transactionIdSchema.optional(),
});

const createOrderSchema = z
  .object({
    customerId: z.string().cuid().optional(),
    customer: newCustomerSchema.optional(),
    items: z.array(orderItemSchema).max(50).default([]),
    // P3.3 — outfit sets, each with a size/colour picked per component.
    sets: z.array(setLineSchema).max(20).default([]),
    courierId: z.string().cuid().nullish(),
    courierZoneId: z.string().cuid().nullish(),
    deliveryCharge: z.coerce.number().min(0).default(0),
    expectedDeliveryDate: z.coerce.date().nullish(),
    advancePayment: advancePaymentSchema.nullish(),
    internalNote: z.string().trim().max(2000).nullish(),
    deliveryNote: z.string().trim().max(200).nullish(),
    // P4.1 — the lead this order converts (PRD §4.5): sets order.leadId and
    // closes the lead as CONVERTED in the same transaction.
    leadId: z.string().cuid().nullish(),
  })
  .refine((data) => Boolean(data.customerId) !== Boolean(data.customer), {
    message: "Provide either an existing customerId or new customer details, not both",
    path: ["customerId"],
  })
  .refine((data) => data.items.length + data.sets.length > 0, { message: "Add at least one item", path: ["items"] });

export async function POST(request: NextRequest) {
  const guard = await requirePermission("order.create");
  if (!guard.ok) return guard.response;

  const parsed = createOrderSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { customerId, customer: newCustomerInput, items, sets, courierId, courierZoneId, deliveryCharge, expectedDeliveryDate, advancePayment, internalNote, deliveryNote, leadId } =
    parsed.data;

  // A lead is converted only by someone who may convert it and can see it —
  // checked before anything is written (the customer below included).
  if (leadId) {
    if (!(await can(guard.user, "lead.convert"))) {
      return NextResponse.json({ error: "You don't have permission to convert leads" }, { status: 403 });
    }
    try {
      await assertLeadConvertible(prisma, guard.user, leadId);
    } catch (error) {
      if (error instanceof LeadError) return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
  }

  // Section 1 — resolve the one person on this order. Existing customer
  // must be one this user can already see; a brand-new customer is
  // auto-deduped on phone (PRD §4.4) so a race with the live search never
  // creates a second row for the same person.
  let resolvedCustomerId: string;
  if (customerId) {
    const existing = await prisma.customer.findFirst({ where: scopedWhere({ id: customerId, deletedAt: null }, guard.user) });
    if (!existing) return NextResponse.json({ error: "Customer not found" }, { status: 400 });
    resolvedCustomerId = existing.id;
  } else {
    if (!(await can(guard.user, "customer.create"))) {
      return NextResponse.json({ error: "You don't have permission to create a new customer" }, { status: 403 });
    }
    const input = newCustomerInput!;
    if (!isValidBdPhone(input.phone)) {
      return NextResponse.json({ error: "Enter a valid Bangladeshi phone number (e.g. 017XXXXXXXX)" }, { status: 400 });
    }
    const normalizedPhone = normalizeBdPhone(input.phone);

    let normalizedAltPhone: string | null = null;
    if (input.altPhone) {
      if (!isValidBdPhone(input.altPhone)) {
        return NextResponse.json({ error: "Enter a valid alternate phone number" }, { status: 400 });
      }
      normalizedAltPhone = normalizeBdPhone(input.altPhone);
    }

    const existingByPhone = await prisma.customer.findUnique({ where: { phone: normalizedPhone } });
    if (existingByPhone) {
      resolvedCustomerId = existingByPhone.id;
    } else {
      const created = await prisma.customer.create({
        data: {
          name: input.name,
          phone: normalizedPhone,
          altPhone: normalizedAltPhone,
          division: input.division || null,
          district: input.district || null,
          thana: input.thana || null,
          addressDetail: input.addressDetail || null,
          createdById: guard.user.id,
          teamId: guard.user.teamId,
        },
      });
      resolvedCustomerId = created.id;
    }
  }

  const hasCostAccess = await can(guard.user, "product.cost.view");
  const hasStockOverride = await can(guard.user, "order.stock_override");

  // P3.3 — outfit sets, checked against the set as it is now and exploded
  // into one ordinary line per component (lib/sets/order-lines.ts). Their
  // lines go through the same stock checks as any item below.
  let resolvedSets: ResolvedSetLine[];
  try {
    resolvedSets = await resolveSetLines(prisma, sets, { hasCostAccess });
  } catch (error) {
    if (error instanceof SetError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  const setChildren = resolvedSets.flatMap((s) => s.children.map((c) => ({ ...c, stockOverrideReason: s.stockOverrideReason ?? undefined, fromSet: true })));

  // Section 2 — items. Validate every variant, the PRD §4.6 price floor and
  // the stock-override rule before writing anything.
  const variantIds = [...new Set([...items.map((i) => i.variantId), ...setChildren.map((c) => c.variantId)])];
  const variants = await prisma.productVariant.findMany({
    where: { id: { in: variantIds } },
    include: { product: { select: { name: true, isActive: true, deletedAt: true, kind: true } } },
  });
  const variantById = new Map(variants.map((v) => [v.id, v]));

  // Multiple lines can reference the same variant — track cumulative
  // committed qty per variant so the stock check sees the true total.
  const committedQtyByVariant = new Map<string, number>();

  for (const item of [...items.map((i) => ({ ...i, fromSet: false })), ...setChildren]) {
    const variant = variantById.get(item.variantId);
    // Packaging material (P3.3) is never sold on its own.
    if (!variant || !variant.isActive || !variant.product || variant.product.deletedAt || variant.product.kind !== "SELLABLE") {
      return NextResponse.json({ error: "One of the selected items is no longer available" }, { status: 400 });
    }

    // A set's floor is checked on the set as a whole.
    if (!item.fromSet && isPriceBelowFloor(item.unitPrice, toNumber(variant.weightedAvgCost), hasCostAccess)) {
      return NextResponse.json(
        { error: `Unit price for ${variant.sku} is below the minimum allowed. Increase the price or ask a Manager/Admin.` },
        { status: 400 },
      );
    }

    const committed = (committedQtyByVariant.get(item.variantId) ?? 0) + item.qty;
    committedQtyByVariant.set(item.variantId, committed);
    const available = variant.stockQty - variant.reservedQty;

    if (committed > available) {
      if (!hasStockOverride) {
        return NextResponse.json(
          { error: `Not enough stock for ${variant.sku} (${available} available, ${committed} requested)` },
          { status: 400 },
        );
      }
      if (!item.stockOverrideReason) {
        return NextResponse.json(
          { error: `A reason is required to sell ${variant.sku} below available stock` },
          { status: 400 },
        );
      }
    }
  }

  // Section 4 — courier + zone, if given, must be a real, matching pair.
  if (courierZoneId) {
    const zone = await prisma.courierZone.findUnique({ where: { id: courierZoneId } });
    if (!zone || (courierId && zone.courierId !== courierId)) {
      return NextResponse.json({ error: "Selected delivery zone does not belong to the selected courier" }, { status: 400 });
    }
  }

  const totals = computeOrderTotals(
    [...items, ...setChildren].map((i) => ({ qty: i.qty, unitPrice: i.unitPrice, lineDiscount: i.lineDiscount })),
    deliveryCharge,
  );
  const dueAmount = computeDueAmount(totals.total, advancePayment?.amount ?? 0);
  if (advancePayment?.method === "STORE_CREDIT" && Math.round(advancePayment.amount * 100) > Math.round(totals.total * 100)) {
    return NextResponse.json({ error: "Store credit can't pay more than the order total." }, { status: 400 });
  }

  try {
    const { order, itemIds } = await prisma.$transaction(async (tx) => {
      const orderNo = await generateOrderNumber(tx);

      const created = await tx.order.create({
        data: {
          orderNo,
          channel: "ONLINE",
          status: "CONFIRMED",
          customerId: resolvedCustomerId,
          courierId: courierId || null,
          courierZoneId: courierZoneId || null,
          deliveryCharge,
          expectedDeliveryDate: expectedDeliveryDate || null,
          subtotal: totals.subtotal,
          discountTotal: totals.discountTotal,
          total: totals.total,
          dueAmount,
          internalNote: internalNote || null,
          deliveryNote: deliveryNote || null,
          leadId: leadId || null,
          createdById: guard.user.id,
          teamId: guard.user.teamId,
        },
      });

      if (leadId) {
        await markLeadConverted(tx, { leadId, customerId: resolvedCustomerId, orderId: created.id, actorId: guard.user.id, request });
      }

      // P5.1 — a deleted (or archived) customer ordering again comes back.
      await reviveCustomer(tx, resolvedCustomerId, guard.user.id, `New order ${orderNo} on this phone`, { request });
      const itemIds: string[] = [];
      for (const item of items) {
        const variant = variantById.get(item.variantId)!;
        const committed = committedQtyByVariant.get(item.variantId) ?? 0;
        const available = variant.stockQty - variant.reservedQty;
        const isOverride = committed > available;

        const createdItem = await tx.orderItem.create({
          data: {
            orderId: created.id,
            variantId: item.variantId,
            qty: item.qty,
            unitPrice: item.unitPrice,
            lineDiscount: item.lineDiscount,
            stockOverride: isOverride,
            stockOverrideReason: isOverride ? item.stockOverrideReason : null,
          },
        });
        itemIds.push(createdItem.id);

        // PRD §4.6/CLAUDE.md rule 10: stock reserved at CONFIRMED. A
        // reservedQty bump isn't a stock_movements event (see the comment
        // in lib/orders/stock.ts), so no ledger row here.
        await reserveVariantStock(tx, item.variantId, item.qty);
      }

      // P3.3 — the sets' component lines, reserved like any line.
      const overrideByVariant = new Map<string, string>();
      for (const s of resolvedSets) {
        for (const c of s.children) {
          const variant = variantById.get(c.variantId)!;
          if ((committedQtyByVariant.get(c.variantId) ?? 0) > variant.stockQty - variant.reservedQty && s.stockOverrideReason) overrideByVariant.set(c.variantId, s.stockOverrideReason);
        }
      }
      for (const child of await writeSetLines(tx, created.id, resolvedSets, { overrideByVariant })) {
        itemIds.push(child.id);
        await reserveVariantStock(tx, child.variantId, child.qty);
      }

      await tx.orderStatusHistory.create({
        data: { orderId: created.id, fromStatus: null, toStatus: "CONFIRMED", changedById: guard.user.id, note: "Order created" },
      });

      if (advancePayment?.method === "STORE_CREDIT") {
        await spendStoreCredit(tx, { customerId: resolvedCustomerId, orderId: created.id, amountPaisa: Math.round(advancePayment.amount * 100), actorId: guard.user.id });
      } else if (advancePayment) {
        await tx.payment.create({
          data: {
            orderId: created.id,
            amount: advancePayment.amount,
            method: advancePayment.method,
            walletId: await resolvePaymentWalletId(tx, advancePayment.method, advancePayment.walletId),
            transactionId: advancePayment.transactionId || null,
            receivedById: guard.user.id,
            verified: false,
          },
        });
      }

      return { order: created, itemIds };
    });

    // Best-effort: invoice v1 is a supplementary artifact, not something
    // the order's existence should depend on if Chromium is unavailable.
    // A missing invoice can be produced later via a re-generate action.
    try {
      await generateOrderInvoice(order.id, guard.user.id);
    } catch (invoiceError) {
      console.error(`Failed to generate invoice v1 for order ${order.orderNo}:`, invoiceError);
    }

    const detail = await loadOrderDetail(order.id);
    const serialized = serializeOrderDetail(detail!);

    await writeAuditLog({
      actorId: guard.user.id,
      action: "order.create",
      entityType: "order",
      entityId: order.id,
      after: serialized,
      request,
    });

    return NextResponse.json(await stripCostFieldsForUser({ order: serialized, itemIds }, guard.user), { status: 201 });
  } catch (error) {
    if (error instanceof WalletError || error instanceof StoreCreditError || error instanceof LeadError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Two distinct unique constraints can land here: transactionId
      // (CLAUDE.md rule 4 — a bKash/Nagad TrxID reused) or orderNo (the
      // order_sequences counter racing with a manually-inserted row, e.g.
      // an import or old seed data). Report which one actually failed
      // instead of always blaming the transaction ID.
      const target = Array.isArray(error.meta?.target) ? error.meta.target.join(",") : String(error.meta?.target ?? "");
      if (target.includes("orderNo")) {
        return NextResponse.json({ error: "Could not generate a unique order number — please try again." }, { status: 409 });
      }
      if (target.includes("leadId")) {
        return NextResponse.json({ error: "This lead has already been converted to an order." }, { status: 409 });
      }
      return NextResponse.json({ error: "This transaction ID has already been used" }, { status: 409 });
    }
    throw error;
  }
}
