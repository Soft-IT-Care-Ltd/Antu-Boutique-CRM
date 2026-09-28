import "server-only";

import type { Prisma } from "@prisma/client";

import { loadEffectivePermissions } from "@/lib/auth/permissions";
import type { Db } from "@/lib/db/tx";
import { todayInDhaka } from "@/lib/inventory/constants";

// CORRECTIONS.md item 11 — a POS may sell an item the system shows as 0 at
// its showroom (the dress is physically in hand). That location's stock
// goes negative and lands on the Negative stock screen; the people who
// manage that location — the users assigned to it, and everyone who acts
// for every location (location.all) — get an in-app alert to fix it with a
// count or a transfer. Packaging running short (P3.3) shows up the same way.

export type NegativeStockRow = {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  sizeName: string;
  colorName: string;
  locationId: string;
  locationName: string;
  qty: number;
  /** When it last moved at that location — roughly when it went negative. */
  updatedAt: string;
};

/** Every (variant, location) below zero, limited to the given locations (null = all). */
export async function listNegativeStock(db: Db, locationIds: string[] | null): Promise<NegativeStockRow[]> {
  const rows = await db.variantStock.findMany({
    where: { qty: { lt: 0 }, ...(locationIds ? { locationId: { in: locationIds } } : {}) },
    orderBy: [{ location: { sortOrder: "asc" } }, { updatedAt: "desc" }],
    select: {
      qty: true,
      updatedAt: true,
      locationId: true,
      location: { select: { name: true } },
      variant: { select: { id: true, sku: true, size: { select: { name: true } }, color: { select: { name: true } }, product: { select: { id: true, name: true } } } },
    },
  });
  return rows.map((r) => ({
    variantId: r.variant.id,
    productId: r.variant.product.id,
    productName: r.variant.product.name,
    sku: r.variant.sku,
    sizeName: r.variant.size.name,
    colorName: r.variant.color.name,
    locationId: r.locationId,
    locationName: r.location.name,
    qty: r.qty,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/**
 * After a stock-out at `locationId`: alerts the location's managers about
 * each of these variants that is now below zero there. One alert per
 * variant, location and Dhaka day (dedupeKey) — selling a second unit the
 * same day doesn't nag twice. Runs in the caller's transaction.
 */
export async function notifyNegativeStock(tx: Prisma.TransactionClient, input: { locationId: string; variantIds: string[] }): Promise<number> {
  if (input.variantIds.length === 0) return 0;
  const negative = await tx.variantStock.findMany({
    where: { locationId: input.locationId, variantId: { in: [...new Set(input.variantIds)] }, qty: { lt: 0 } },
    select: { qty: true, variant: { select: { id: true, sku: true, size: { select: { name: true } }, color: { select: { name: true } }, product: { select: { name: true } } } }, location: { select: { name: true } } },
  });
  if (negative.length === 0) return 0;

  const recipients = await negativeStockRecipients(tx, input.locationId);
  if (recipients.length === 0) return 0;
  const day = todayInDhaka();
  const data = negative.flatMap((n) =>
    recipients.map((userId) => ({
      userId,
      kind: "NEGATIVE_STOCK" as const,
      title: `Negative stock at ${n.location.name}: ${n.variant.sku} is at ${n.qty}`,
      body: `${n.variant.product.name} (${n.variant.size.name} / ${n.variant.color.name}) was sold or used with no stock showing at ${n.location.name}. Count it or transfer stock in to fix it.`,
      href: "/inventory/negative-stock",
      dedupeKey: `negative-stock:${input.locationId}:${n.variant.id}:${day}`,
    })),
  );
  return (await tx.notification.createMany({ data, skipDuplicates: true })).count;
}

async function negativeStockRecipients(db: Db, locationId: string): Promise<string[]> {
  const users = await db.user.findMany({ where: { isActive: true }, select: { id: true, locations: { where: { locationId }, select: { locationId: true } } } });
  const out: string[] = [];
  for (const u of users) {
    if (u.locations.length > 0) {
      out.push(u.id);
      continue;
    }
    if ((await loadEffectivePermissions(db, u.id)).has("location.all")) out.push(u.id);
  }
  return out;
}
