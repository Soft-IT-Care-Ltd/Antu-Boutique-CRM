import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { CUSTOMER_TAG_VALUES } from "@/lib/customers/constants";
import { isValidBdPhone, normalizeBdPhone } from "@/lib/customers/phone";
import { serializeCustomerListItem } from "@/lib/customers/serialize";
import type { PermissionKey } from "@/lib/auth/permission-definitions";

const VIEW_PERMISSIONS: PermissionKey[] = ["customer.view_own", "customer.view_team", "customer.view_all"];

const querySchema = z.object({
  q: z.string().trim().optional(),
  tag: z.enum(CUSTOMER_TAG_VALUES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(150),
  phone: z.string().trim().min(1),
  altPhone: z.string().trim().max(20).nullish(),
  division: z.string().trim().max(60).nullish(),
  district: z.string().trim().max(60).nullish(),
  thana: z.string().trim().max(60).nullish(),
  addressDetail: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  tags: z.array(z.enum(CUSTOMER_TAG_VALUES)).max(CUSTOMER_TAG_VALUES.length).default([]),
});

export async function GET(request: NextRequest) {
  const guard = await requirePermission(VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  }
  const { q, tag, page, pageSize } = parsed.data;

  const andConditions: Prisma.CustomerWhereInput[] = [{ deletedAt: null }];
  if (tag) andConditions.push({ tags: { has: tag } });
  if (q) {
    // Phone-first search-as-you-type (PRD §4.4): a query that looks like
    // digits matches phone/altPhone by prefix; it also always matches name,
    // so typing part of a name still works.
    const digits = q.replace(/[\s-]/g, "");
    andConditions.push({
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { phone: { contains: digits } },
        { altPhone: { contains: digits } },
      ],
    });
  }

  const where: Prisma.CustomerWhereInput = scopedWhere({ AND: andConditions }, guard.user);

  const [total, customers] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return NextResponse.json({
    items: customers.map(serializeCustomerListItem),
    total,
    page,
    pageSize,
  });
}

export async function POST(request: NextRequest) {
  const guard = await requirePermission("customer.create");
  if (!guard.ok) return guard.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { name, phone, altPhone, division, district, thana, addressDetail, notes, tags } = parsed.data;

  if (!isValidBdPhone(phone)) {
    return NextResponse.json({ error: "Enter a valid Bangladeshi phone number (e.g. 017XXXXXXXX)" }, { status: 400 });
  }
  const normalizedPhone = normalizeBdPhone(phone);

  let normalizedAltPhone: string | null = null;
  if (altPhone) {
    if (!isValidBdPhone(altPhone)) {
      return NextResponse.json({ error: "Enter a valid alternate phone number" }, { status: 400 });
    }
    normalizedAltPhone = normalizeBdPhone(altPhone);
    if (normalizedAltPhone === normalizedPhone) {
      return NextResponse.json({ error: "Alternate number must differ from the primary phone" }, { status: 400 });
    }
  }

  const clash = await prisma.customer.findUnique({ where: { phone: normalizedPhone } });
  if (clash) {
    // A deleted customer still owns their number (it's unique). Their
    // record comes back when they order again (lib/trash/service.ts
    // reviveCustomer), or from the Trash within 30 days.
    const error = clash.deletedAt
      ? "This number belongs to a deleted customer. Place an order with it and their record comes back, or restore them from the Trash."
      : "A customer with this phone number already exists";
    return NextResponse.json({ error, customerId: clash.deletedAt ? undefined : clash.id }, { status: 409 });
  }

  const customer = await prisma.customer.create({
    data: {
      name,
      phone: normalizedPhone,
      altPhone: normalizedAltPhone,
      division: division || null,
      district: district || null,
      thana: thana || null,
      addressDetail: addressDetail || null,
      notes: notes || null,
      tags,
      createdById: guard.user.id,
      teamId: guard.user.teamId,
    },
  });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "customer.create",
    entityType: "customer",
    entityId: customer.id,
    after: customer,
    request,
  });

  return NextResponse.json({ customer: serializeCustomerListItem(customer) }, { status: 201 });
}
