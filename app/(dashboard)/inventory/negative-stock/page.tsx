import Link from "next/link";
import { CircleCheck } from "lucide-react";

import { InventoryHeader } from "@/components/inventory/inventory-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDhakaDateTime } from "@/lib/inventory/constants";
import { listNegativeStock } from "@/lib/inventory/negative-stock";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { getLocationAccess } from "@/lib/locations/service";
import { prisma } from "@/lib/prisma";

// CORRECTIONS.md item 11 — every location whose stock went below zero (a
// POS sale of a dress in hand that the system showed as 0, or packaging
// used up). A location incharge sees their own locations; location.all
// sees every one. Fixed by a stock count (adjustment) or a transfer in.
export default async function NegativeStockPage() {
  const access = await getInventoryAccess();
  const locationAccess = await getLocationAccess(prisma, access.user);
  const rows = await listNegativeStock(prisma, locationAccess.all ? null : locationAccess.ids);
  const scoped = !locationAccess.all;

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <InventoryHeader
        title="Negative stock"
        description={
          rows.length === 0
            ? `No location${scoped ? " you manage" : ""} is below zero.`
            : `${rows.length} item(s) sold or used with no stock showing. Count them, or transfer stock in, to put them right.`
        }
        links={access.navLinks}
      />
      {scoped && locationAccess.ids.length === 0 ? <p className="text-sm text-muted-foreground">You aren&apos;t assigned to any location — this list shows the locations you manage.</p> : null}

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <CircleCheck className="size-8 text-emerald-600" />
          <p className="text-sm font-medium">Nothing below zero</p>
          <p className="text-sm text-muted-foreground">When a showroom sells a dress its figures say it doesn&apos;t have, it shows up here.</p>
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-2 md:hidden">
            {rows.map((r) => (
              <li key={`${r.variantId}:${r.locationId}`} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{r.productName}</p>
                  <p className="text-sm text-muted-foreground">
                    <b className="text-foreground">{r.sizeName}</b> · {r.colorName} · <span className="font-mono text-xs">{r.sku}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">{r.locationName}</p>
                </div>
                <span className="text-xl font-semibold text-destructive tabular-nums">{r.qty}</span>
              </li>
            ))}
          </ul>
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">Stock</TableHead>
                  <TableHead>Last moved</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={`${r.variantId}:${r.locationId}`}>
                    <TableCell>
                      {access.canViewCatalog ? (
                        <Link href={`/catalog/products/${r.productId}`} className="font-medium hover:underline">
                          {r.productName}
                        </Link>
                      ) : (
                        <span className="font-medium">{r.productName}</span>
                      )}
                      <span className="text-muted-foreground">
                        {" "}
                        · <b className="text-foreground">{r.sizeName}</b> · {r.colorName}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.sku}</TableCell>
                    <TableCell>{r.locationName}</TableCell>
                    <TableCell className="text-right font-semibold text-destructive tabular-nums">{r.qty}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {access.canViewLedger ? (
                        <Link href={`/inventory/movements?q=${encodeURIComponent(r.sku)}&locationId=${r.locationId}`} className="hover:underline">
                          {formatDhakaDateTime(r.updatedAt)}
                        </Link>
                      ) : (
                        formatDhakaDateTime(r.updatedAt)
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
