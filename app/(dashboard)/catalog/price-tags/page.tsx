import { z } from "zod";

import { PriceTagPrinter, type TagSourceItem } from "@/components/catalog/price-tag-printer";
import { guardPage } from "@/lib/auth/guard-page";
import { tagsForProduct, tagsForPurchase } from "@/lib/catalog/price-tags";
import { formatDhakaDate } from "@/lib/inventory/constants";
import { prisma } from "@/lib/prisma";

// P3.1 — price tags for the shop floor: product name, size, colour, price
// and a barcode of the SKU, on label-printer rolls or A4 sticker sheets.
// ?productId= / ?purchaseId= preload the list (the "Print tags" buttons on
// the product and purchase screens).
const searchSchema = z.object({ productId: z.string().max(50).optional(), purchaseId: z.string().max(50).optional() });

export default async function PriceTagsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await guardPage("/catalog/price-tags");
  const parsed = searchSchema.safeParse(await searchParams);
  const { productId, purchaseId } = parsed.success ? parsed.data : {};

  let initialItems: TagSourceItem[] = [];
  let initialSource: string | null = null;
  if (purchaseId) {
    const [items, purchase] = await Promise.all([
      tagsForPurchase(prisma, purchaseId),
      prisma.purchase.findUnique({ where: { id: purchaseId }, select: { purchaseDate: true, invoiceNo: true, supplier: { select: { name: true } } } }),
    ]);
    if (items && purchase) {
      initialItems = items;
      initialSource = `Loaded everything received from ${purchase.supplier.name} on ${formatDhakaDate(purchase.purchaseDate)}${purchase.invoiceNo ? ` (invoice ${purchase.invoiceNo})` : ""} — one tag per piece.`;
    }
  } else if (productId) {
    initialItems = await tagsForProduct(prisma, productId);
    if (initialItems.length > 0) initialSource = `Loaded every size and colour of ${initialItems[0].productName} — one tag per piece on hand.`;
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">Price tags</h1>
        <p className="text-sm text-muted-foreground">Name, size, colour, price and a scannable barcode of the SKU — for a label printer or A4 sticker sheets.</p>
      </div>
      <PriceTagPrinter initialItems={initialItems} initialSource={initialSource} />
    </div>
  );
}
