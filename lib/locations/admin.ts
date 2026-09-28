import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { writeAuditLogWith } from "@/lib/audit/log";
import type { Db } from "@/lib/db/tx";
import { withTx } from "@/lib/db/tx";
import { LOCATION_TYPES, type LocationTypeValue } from "@/lib/locations/constants";
import { LocationError } from "@/lib/locations/service";

// CORRECTIONS.md item 2 — Settings → Locations (Admin, settings.manage):
// name, type, address, packing hub (exactly one), has POS, active, and the
// location's managers / incharges. Locations are switched off, never
// deleted — the ledger points at them. Every change is audit-logged with
// before/after, managers included (who may act for a location's stock is a
// permission change in all but name).

export const locationInputSchema = z.object({
  name: z.string().trim().min(2, "Give the location a name").max(80),
  type: z.enum(LOCATION_TYPES),
  address: z.string().trim().max(300).nullish(),
  isPackingHub: z.boolean().default(false),
  hasPos: z.boolean().default(false),
  isActive: z.boolean().default(true),
  userIds: z.array(z.string().trim().min(1).max(50)).max(200).default([]),
});
export type LocationInput = z.infer<typeof locationInputSchema>;

export type LocationSettingsRow = {
  id: string;
  name: string;
  type: LocationTypeValue;
  address: string | null;
  isPackingHub: boolean;
  hasPos: boolean;
  isActive: boolean;
  /** Units held there now (may be negative). */
  units: number;
  managers: { id: string; name: string; roleLabel: string }[];
};

export async function listLocationSettings(db: Db): Promise<{ locations: LocationSettingsRow[]; staff: { id: string; name: string; roleLabel: string }[] }> {
  const [locations, units, staff] = await Promise.all([
    db.location.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { users: { include: { user: { select: { id: true, name: true, isActive: true, role: { select: { label: true } } } } } } },
    }),
    db.variantStock.groupBy({ by: ["locationId"], _sum: { qty: true } }),
    db.user.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true, role: { select: { label: true } } } }),
  ]);
  const unitsAt = new Map(units.map((u) => [u.locationId, u._sum.qty ?? 0]));
  return {
    locations: locations.map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
      address: l.address,
      isPackingHub: l.isPackingHub,
      hasPos: l.hasPos,
      isActive: l.isActive,
      units: unitsAt.get(l.id) ?? 0,
      managers: l.users.filter((u) => u.user.isActive).map((u) => ({ id: u.user.id, name: u.user.name, roleLabel: u.user.role.label })),
    })),
    staff: staff.map((s) => ({ id: s.id, name: s.name, roleLabel: s.role.label })),
  };
}

async function snapshot(tx: Prisma.TransactionClient, id: string) {
  const l = await tx.location.findUniqueOrThrow({ where: { id }, include: { users: { select: { userId: true } } } });
  return { name: l.name, type: l.type, address: l.address, isPackingHub: l.isPackingHub, hasPos: l.hasPos, isActive: l.isActive, userIds: l.users.map((u) => u.userId).sort() };
}

/** Creates (id null) or updates a location, its hub/POS flags and its managers, in one audited transaction. */
export async function saveLocation(db: Db, id: string | null, input: LocationInput, actorId: string, request?: Request): Promise<{ id: string }> {
  return withTx(db, async (tx) => {
    const before = id ? await snapshot(tx, id).catch(() => null) : null;
    if (id && !before) throw new LocationError("Location not found.", 404);

    if (before?.isPackingHub && !input.isPackingHub) throw new LocationError("There must always be a packing hub — make another location the hub instead.");
    if (input.isPackingHub && !input.isActive) throw new LocationError("The packing hub can't be switched off — make another location the hub first.");
    if (id && before?.isActive && !input.isActive) {
      const held = await tx.variantStock.count({ where: { locationId: id, qty: { not: 0 } } });
      if (held > 0) throw new LocationError(`It still holds stock (${held} size/colour(s) not at zero) — count or move it first.`);
    }
    const users = input.userIds.length ? await tx.user.count({ where: { id: { in: input.userIds }, isActive: true } }) : 0;
    if (users !== new Set(input.userIds).size) throw new LocationError("One of the people picked is not an active user.");

    // Moving the hub: the old one stops being it in the same transaction.
    if (input.isPackingHub) await tx.location.updateMany({ where: { isPackingHub: true, ...(id ? { id: { not: id } } : {}) }, data: { isPackingHub: false } });

    const data = { name: input.name, type: input.type, address: input.address?.trim() || null, isPackingHub: input.isPackingHub, hasPos: input.hasPos, isActive: input.isActive };
    let locationId = id;
    try {
      if (locationId) await tx.location.update({ where: { id: locationId }, data });
      else locationId = (await tx.location.create({ data: { ...data, sortOrder: (await tx.location.count()) + 1 }, select: { id: true } })).id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new LocationError("Another location already has that name.", 409);
      throw error;
    }

    await tx.userLocation.deleteMany({ where: { locationId, userId: { notIn: input.userIds } } });
    if (input.userIds.length) await tx.userLocation.createMany({ data: input.userIds.map((userId) => ({ userId, locationId: locationId! })), skipDuplicates: true });

    await writeAuditLogWith(tx, {
      actorId,
      action: id ? "location.update" : "location.create",
      entityType: "location",
      entityId: locationId,
      before: before ?? undefined,
      after: await snapshot(tx, locationId),
      request,
    });
    return { id: locationId };
  });
}
