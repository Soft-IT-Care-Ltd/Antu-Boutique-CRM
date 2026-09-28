import "server-only";

import type { Prisma } from "@prisma/client";

import { can } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/types";
import type { Db } from "@/lib/db/tx";
import type { LocationOption, LocationQty } from "@/lib/locations/constants";

// CORRECTIONS.md item 2 — where stock lives, and who acts for which place.
//
//   - The packing hub (exactly one) is where online orders are packed:
//     packing deducts there, courier returns restock there.
//   - A POS sells from its showroom's location (item 11).
//   - Location managers / incharges are users assigned to locations
//     (user_locations). They act — adjust, write off, receive purchases,
//     put opening stock — only for their locations. location.all (Admin,
//     Manager) acts for every one. Seeing stock is not scoped: the stock
//     lookup shows every location to anyone with inventory.view, so a
//     salesperson can tell a customer where a dress is.

export class LocationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const optionSelect = { id: true, name: true, type: true, isPackingHub: true, hasPos: true, isActive: true } satisfies Prisma.LocationSelect;

export async function listLocations(db: Db, opts: { activeOnly?: boolean } = {}): Promise<LocationOption[]> {
  return db.location.findMany({
    where: opts.activeOnly ? { isActive: true } : {},
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: optionSelect,
  });
}

export async function getPackingHub(db: Db): Promise<{ id: string; name: string }> {
  const hub = await db.location.findFirst({ where: { isPackingHub: true, isActive: true }, select: { id: true, name: true } });
  if (!hub) throw new LocationError("No packing hub is set — choose one in Settings → Locations.", 409);
  return hub;
}

export type LocationAccess = { all: boolean; ids: string[] };

/** Which locations this person acts for: every one (location.all), or the ones they're assigned. */
export async function getLocationAccess(db: Db, user: SessionUser): Promise<LocationAccess> {
  const [all, rows] = await Promise.all([can(user, "location.all"), db.userLocation.findMany({ where: { userId: user.id }, select: { locationId: true } })]);
  return { all, ids: rows.map((r) => r.locationId) };
}

export function canActAt(access: LocationAccess, locationId: string): boolean {
  return access.all || access.ids.includes(locationId);
}

/** The active locations this person may pick on a stock form. */
export async function listActableLocations(db: Db, user: SessionUser): Promise<LocationOption[]> {
  const [locations, access] = await Promise.all([listLocations(db, { activeOnly: true }), getLocationAccess(db, user)]);
  return locations.filter((l) => canActAt(access, l.id));
}

/** Refuses a stock action at a location that is switched off, unknown, or not this person's. */
export async function assertCanActAt(db: Db, user: SessionUser, locationId: string): Promise<{ id: string; name: string }> {
  const location = await db.location.findUnique({ where: { id: locationId }, select: { id: true, name: true, isActive: true } });
  if (!location) throw new LocationError("That location doesn't exist.");
  if (!location.isActive) throw new LocationError(`${location.name} is switched off.`);
  if (!canActAt(await getLocationAccess(db, user), locationId)) throw new LocationError(`You don't act for ${location.name}.`, 403);
  return { id: location.id, name: location.name };
}

/**
 * The showroom a POS sale sells from: the POS location this person is
 * assigned to; with only one POS in the business (Shyamoli today), that
 * one for anyone who may sell.
 */
export async function getPosLocation(db: Db, user: SessionUser): Promise<{ id: string; name: string }> {
  const candidates = await db.location.findMany({ where: { hasPos: true, isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true } });
  if (candidates.length === 0) throw new LocationError("No showroom has a POS — set one in Settings → Locations.", 409);
  const access = await getLocationAccess(db, user);
  const mine = candidates.find((c) => access.ids.includes(c.id));
  if (mine) return mine;
  if (candidates.length === 1 || access.all) return candidates[0];
  throw new LocationError("You're not assigned to a showroom with a POS. Ask an Admin to assign you in Settings → Locations.", 403);
}

/** Each variant's stock at every location that holds any (or ever held any). */
export async function stockByLocation(db: Db, variantIds: string[]): Promise<Map<string, LocationQty[]>> {
  const out = new Map<string, LocationQty[]>();
  if (variantIds.length === 0) return out;
  const rows = await db.variantStock.findMany({
    where: { variantId: { in: variantIds } },
    select: { variantId: true, locationId: true, qty: true, location: { select: { name: true, sortOrder: true } } },
    orderBy: [{ location: { sortOrder: "asc" } }, { location: { name: "asc" } }],
  });
  for (const r of rows) {
    const list = out.get(r.variantId) ?? [];
    list.push({ locationId: r.locationId, name: r.location.name, qty: r.qty });
    out.set(r.variantId, list);
  }
  return out;
}

/** "3 at Shyamoli Showroom, 1 at Studio" — where else a variant is, for refusal messages. */
export function describeElsewhere(stock: LocationQty[] | undefined, exceptLocationId: string): string {
  const others = (stock ?? []).filter((s) => s.locationId !== exceptLocationId && s.qty > 0);
  return others.length === 0 ? "none at any other location" : others.map((s) => `${s.qty} at ${s.name}`).join(", ");
}
