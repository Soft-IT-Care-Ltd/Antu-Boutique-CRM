import { redirect } from "next/navigation";
import { z } from "zod";

import { InventoryHeader } from "@/components/inventory/inventory-header";
import { PurchaseForm } from "@/components/inventory/purchase-form";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { listActableLocations } from "@/lib/locations/service";
import { prisma } from "@/lib/prisma";

// C5 — "Pre-fill a purchase" on the Waiting for stock page links here with
// ?prefill=<variantId>:<qty>,… — what the waiting orders need. Anything that
// doesn't parse is dropped; nothing is saved until the person saves it.
const prefillSchema = z
  .string()
  .max(5000)
  .transform((raw) =>
    raw
      .split(",")
      .slice(0, 100)
      .map((part) => part.split(":"))
      .filter((p): p is [string, string] => p.length === 2 && z.string().cuid().safeParse(p[0]).success && /^\d{1,4}$/.test(p[1]) && Number(p[1]) > 0)
      .map(([variantId, qty]) => ({ variantId, qty: Number(qty) })),
  )
  .catch([]);

async function prefillLines(raw: string | string[] | undefined, withCost: boolean) {
  const wanted = typeof raw === "string" ? prefillSchema.parse(raw) : [];
  if (wanted.length === 0) return [];
  const variants = await prisma.productVariant.findMany({
    where: { id: { in: wanted.map((w) => w.variantId) }, isActive: true },
    select: { id: true, sku: true, stockQty: true, reservedQty: true, priceOverride: true, weightedAvgCost: true, size: { select: { name: true } }, color: { select: { name: true, hexCode: true } }, product: { select: { name: true, basePrice: true } } },
  });
  const byId = new Map(variants.map((v) => [v.id, v]));
  return wanted.flatMap(({ variantId, qty }) => {
    const v = byId.get(variantId);
    if (!v) return [];
    return [
      {
        qty,
        variant: {
          variantId: v.id,
          productName: v.product.name,
          sku: v.sku,
          sizeName: v.size.name,
          colorName: v.color.name,
          colorHex: v.color.hexCode,
          available: v.stockQty - v.reservedQty,
          effectivePrice: (v.priceOverride ?? v.product.basePrice).toFixed(2),
          ...(withCost ? { weightedAvgCost: v.weightedAvgCost.toFixed(2) } : {}),
        },
      },
    ];
  });
}

export default async function NewPurchasePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await getInventoryAccess();
  if (!access.canViewPurchases) redirect("/inventory");
  const initialLines = await prefillLines((await searchParams).prefill, access.hasCostAccess);

  const [suppliers, locations] = await Promise.all([
    prisma.supplier.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    // C3 — only locations this person receives stock into.
    listActableLocations(prisma, access.user),
  ]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-5xl md:p-6">
      <InventoryHeader
        title="New purchase"
        description="Stock goes up at each line's location and weighted average cost is recalculated the moment you save."
        links={access.navLinks}
      />
      {locations.length === 0 ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          You aren&apos;t assigned to any stock location, so there&apos;s nowhere to receive a purchase. Ask an Admin to assign you in Settings → Locations.
        </p>
      ) : (
        <PurchaseForm suppliers={suppliers} locations={locations} initialLines={initialLines} />
      )}
    </div>
  );
}
