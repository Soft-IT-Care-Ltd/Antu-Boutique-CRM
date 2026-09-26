import "server-only";

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { writeAuditLogWith } from "@/lib/audit/log";
import { withTx, type Db } from "@/lib/db/tx";
import { DELIVERY_ZONE_VALUES } from "@/lib/orders/constants";

// PRD §4.9 / §4.17 "courier companies and zone charges": name, contact, and
// per zone what the CUSTOMER is charged for delivery, the courier's COD % and
// its return charge. The order form reads these (GET /api/couriers); an
// order keeps the charge it was placed with. What WE pay the courier is the
// separate cost-rate table (Courier → Steadfast, cost data).

const money = z.coerce.number().min(0, "0 or more").max(100_000).multipleOf(0.01, "At most 2 decimals");

export const zoneChargeSchema = z.object({
  zone: z.enum(DELIVERY_ZONE_VALUES),
  charge: money,
  codChargePercent: z.coerce.number().min(0).max(100, "At most 100%").multipleOf(0.01, "At most 2 decimals"),
  returnCharge: money,
});

const courierFields = {
  name: z.string().trim().min(2, "Give the courier a name").max(60),
  contact: z.string().trim().max(120).nullish(),
  isActive: z.boolean(),
  zones: z
    .array(zoneChargeSchema)
    .max(DELIVERY_ZONE_VALUES.length)
    .refine((zones) => new Set(zones.map((z) => z.zone)).size === zones.length, "Each zone may appear once"),
};

export const courierSchema = z.object({ ...courierFields, isActive: courierFields.isActive.default(true), zones: courierFields.zones.default([]) });

/** No defaults: a field left out of an edit stays as it is. */
export const courierPatchSchema = z.object(courierFields).partial();

export class CourierSettingsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type CourierInput = z.infer<typeof courierSchema>;

const include = { zones: { orderBy: { zone: "asc" } }, _count: { select: { orders: true } } } satisfies Prisma.CourierCompanyInclude;

function serialize(c: Prisma.CourierCompanyGetPayload<{ include: typeof include }>) {
  return {
    id: c.id,
    name: c.name,
    contact: c.contact,
    provider: c.provider,
    isActive: c.isActive,
    orders: c._count.orders,
    zones: DELIVERY_ZONE_VALUES.map((zone) => {
      const row = c.zones.find((z) => z.zone === zone);
      return { zone, configured: Boolean(row), charge: row?.charge.toString() ?? "0", codChargePercent: row?.codChargePercent.toString() ?? "0", returnCharge: row?.returnCharge.toString() ?? "0" };
    }),
  };
}

export type CourierSettingsView = ReturnType<typeof serialize>;

export async function listCourierSettings(db: Db): Promise<CourierSettingsView[]> {
  const rows = await db.courierCompany.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }], include });
  return rows.map(serialize);
}

async function writeZones(tx: Prisma.TransactionClient, courierId: string, zones: CourierInput["zones"]) {
  for (const z of zones) {
    await tx.courierZone.upsert({
      where: { courierId_zone: { courierId, zone: z.zone } },
      update: { charge: z.charge, codChargePercent: z.codChargePercent, returnCharge: z.returnCharge },
      create: { courierId, zone: z.zone, charge: z.charge, codChargePercent: z.codChargePercent, returnCharge: z.returnCharge },
    });
  }
}

async function assertFreeName(tx: Prisma.TransactionClient, name: string, exceptId?: string) {
  const clash = await tx.courierCompany.findFirst({ where: { name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
  if (clash) throw new CourierSettingsError(`A courier called "${name}" already exists`, 409);
}

export async function createCourier(db: Db, actorId: string, input: CourierInput, request?: Request) {
  return withTx(db, async (tx) => {
    await assertFreeName(tx, input.name);
    const courier = await tx.courierCompany.create({ data: { name: input.name, contact: input.contact || null, isActive: input.isActive } });
    await writeZones(tx, courier.id, input.zones);
    const after = serialize(await tx.courierCompany.findUniqueOrThrow({ where: { id: courier.id }, include }));
    await writeAuditLogWith(tx, { actorId, action: "courier.create", entityType: "courier_company", entityId: courier.id, after, request });
    return after;
  });
}

/** Zone charges are prices: before/after in the audit log. */
export async function updateCourier(db: Db, actorId: string, id: string, input: Partial<CourierInput>, request?: Request) {
  return withTx(db, async (tx) => {
    const existing = await tx.courierCompany.findUnique({ where: { id }, include });
    if (!existing) throw new CourierSettingsError("Courier not found", 404);
    if (input.name) await assertFreeName(tx, input.name, id);
    await tx.courierCompany.update({ where: { id }, data: { name: input.name, contact: input.contact === undefined ? undefined : input.contact || null, isActive: input.isActive } });
    if (input.zones) await writeZones(tx, id, input.zones);
    const after = serialize(await tx.courierCompany.findUniqueOrThrow({ where: { id }, include }));
    await writeAuditLogWith(tx, { actorId, action: "courier.update", entityType: "courier_company", entityId: id, before: serialize(existing), after, request });
    return after;
  });
}
