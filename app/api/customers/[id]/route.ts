import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit/log";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/require-permission";
import { scopedWhere } from "@/lib/auth/scope";
import { CUSTOMER_TAG_VALUES } from "@/lib/customers/constants";
import { isValidBdPhone, normalizeBdPhone } from "@/lib/customers/phone";
import { computeCustomerStats } from "@/lib/customers/stats";
import type { CustomerTagValue } from "@/lib/customers/constants";
import type { PermissionKey } from "@/lib/auth/permission-definitions";

const VIEW_PERMISSIONS: PermissionKey[] = ["customer.view_own", "customer.view_team", "customer.view_all"];

const updateSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  phone: z.string().trim().min(1).optional(),
  altPhone: z.string().trim().max(20).nullish(),
  division: z.string().trim().max(60).nullish(),
  district: z.string().trim().max(60).nullish(),
  thana: z.string().trim().max(60).nullish(),
  addressDetail: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  tags: z.array(z.enum(CUSTOMER_TAG_VALUES)).max(CUSTOMER_TAG_VALUES.length).optional(),
});

async function findScopedCustomer(id: string, user: Parameters<typeof scopedWhere>[1]) {
  return prisma.customer.findFirst({
    where: scopedWhere({ id, deletedAt: null }, user),
    include: { createdBy: { select: { id: true, name: true } } },
  });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const customer = await findScopedCustomer(id, guard.user);
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const stats = await computeCustomerStats(customer.id);

  return NextResponse.json({
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      altPhone: customer.altPhone,
      division: customer.division,
      district: customer.district,
      thana: customer.thana,
      addressDetail: customer.addressDetail,
      notes: customer.notes,
      tags: customer.tags as CustomerTagValue[],
      createdBy: customer.createdBy,
      createdAt: customer.createdAt.toISOString(),
      updatedAt: customer.updatedAt.toISOString(),
      stats,
    },
  });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("customer.edit");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const existing = await findScopedCustomer(id, guard.user);
  if (!existing) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { phone, altPhone, division, district, thana, addressDetail, notes, ...rest } = parsed.data;

  let normalizedPhone: string | undefined;
  if (phone !== undefined) {
    if (!isValidBdPhone(phone)) {
      return NextResponse.json({ error: "Enter a valid Bangladeshi phone number (e.g. 017XXXXXXXX)" }, { status: 400 });
    }
    normalizedPhone = normalizeBdPhone(phone);
    if (normalizedPhone !== existing.phone) {
      const clash = await prisma.customer.findUnique({ where: { phone: normalizedPhone } });
      if (clash) return NextResponse.json({ error: "A customer with this phone number already exists" }, { status: 409 });
    }
  }

  let normalizedAltPhone: string | null | undefined;
  if (altPhone !== undefined) {
    if (altPhone) {
      if (!isValidBdPhone(altPhone)) {
        return NextResponse.json({ error: "Enter a valid alternate phone number" }, { status: 400 });
      }
      normalizedAltPhone = normalizeBdPhone(altPhone);
      if (normalizedAltPhone === (normalizedPhone ?? existing.phone)) {
        return NextResponse.json({ error: "Alternate number must differ from the primary phone" }, { status: 400 });
      }
    } else {
      normalizedAltPhone = null;
    }
  }

  const customer = await prisma.customer.update({
    where: { id },
    data: {
      ...rest,
      ...(normalizedPhone !== undefined ? { phone: normalizedPhone } : {}),
      ...(normalizedAltPhone !== undefined ? { altPhone: normalizedAltPhone } : {}),
      ...(division !== undefined ? { division: division || null } : {}),
      ...(district !== undefined ? { district: district || null } : {}),
      ...(thana !== undefined ? { thana: thana || null } : {}),
      ...(addressDetail !== undefined ? { addressDetail: addressDetail || null } : {}),
      ...(notes !== undefined ? { notes: notes || null } : {}),
    },
    include: { createdBy: { select: { id: true, name: true } } },
  });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "customer.update",
    entityType: "customer",
    entityId: customer.id,
    before: existing,
    after: customer,
    request,
  });

  const stats = await computeCustomerStats(customer.id);

  return NextResponse.json({
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      altPhone: customer.altPhone,
      division: customer.division,
      district: customer.district,
      thana: customer.thana,
      addressDetail: customer.addressDetail,
      notes: customer.notes,
      tags: customer.tags as CustomerTagValue[],
      createdBy: customer.createdBy,
      createdAt: customer.createdAt.toISOString(),
      updatedAt: customer.updatedAt.toISOString(),
      stats,
    },
  });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission("customer.delete");
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const existing = await findScopedCustomer(id, guard.user);
  if (!existing) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const customer = await prisma.customer.update({ where: { id }, data: { deletedAt: new Date() } });

  await writeAuditLog({
    actorId: guard.user.id,
    action: "customer.trash",
    entityType: "customer",
    entityId: id,
    before: { deletedAt: null },
    after: { deletedAt: customer.deletedAt },
    request,
  });

  return NextResponse.json({ ok: true });
}
