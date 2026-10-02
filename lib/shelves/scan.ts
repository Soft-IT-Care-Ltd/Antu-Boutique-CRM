import type { Db } from "@/lib/db/tx";
import { ScanError } from "@/lib/inventory/scan-lookup";
import { normalizeShelfCode } from "@/lib/shelves/constants";

// C4b — every scan box at a shelf-using location takes dress tags AND shelf
// labels. A shelf code always has a hyphen and a SKU never does, so one
// scan is unambiguously one or the other.

export type ScannedShelf = { id: string; code: string };

/** The shelf a scanned label names at this location; null when the scan isn't a shelf code at all. */
export async function findShelfByScan(db: Db, raw: string, locationId: string): Promise<ScannedShelf | null> {
  const code = normalizeShelfCode(raw);
  if (!code) return null;
  const shelf = await db.shelf.findUnique({ where: { locationId_code: { locationId, code } }, select: { id: true, code: true, isActive: true, location: { select: { name: true, usesShelves: true } } } });
  if (!shelf) {
    const location = await db.location.findUnique({ where: { id: locationId }, select: { name: true } });
    throw new ScanError(`There's no shelf ${code} at ${location?.name ?? "this location"}.`, 404);
  }
  if (!shelf.location.usesShelves) throw new ScanError(`${shelf.location.name} doesn't use shelves.`, 409);
  if (!shelf.isActive) throw new ScanError(`Shelf ${code} is switched off.`, 409);
  return { id: shelf.id, code: shelf.code };
}
