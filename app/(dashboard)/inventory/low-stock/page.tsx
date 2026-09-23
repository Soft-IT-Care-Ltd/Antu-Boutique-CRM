import Link from "next/link";
import { PackageCheck } from "lucide-react";

import { InventoryHeader } from "@/components/inventory/inventory-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { getInventoryAccess } from "@/lib/inventory/page-context";
import { getLowStockAlerts } from "@/lib/inventory/stock-report";

// PRD §4.2: low-stock alerts per variant, rolled up per product
// ("Kurti #12: only XL left"). No cost data at all on this screen, so
// every inventory.view role gets the same view.
export default async function LowStockPage() {
  const access = await getInventoryAccess();
  const alerts = await getLowStockAlerts();
  const variantCount = alerts.reduce((sum, a) => sum + a.lowVariants.length, 0);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <InventoryHeader
        title="Low stock"
        description={
          alerts.length === 0
            ? "Every active variant is above its low-stock threshold."
            : `${variantCount} variant(s) across ${alerts.length} product(s) at or below their threshold.`
        }
        links={access.navLinks}
      />

      {alerts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <PackageCheck className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium">Nothing is running low</p>
          <p className="text-sm text-muted-foreground">Alerts appear here when a variant&apos;s available stock drops to its threshold.</p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {alerts.map((alert) => (
            <Card key={alert.productId} size="sm">
              <CardHeader>
                <CardTitle>
                  {access.canViewCatalog ? (
                    <Link href={`/catalog/products/${alert.productId}`} className="hover:underline">
                      {alert.productName}
                    </Link>
                  ) : (
                    alert.productName
                  )}
                </CardTitle>
                <CardDescription>
                  <span className={alert.outCount > 0 ? "font-medium text-destructive" : "font-medium text-foreground"}>{alert.message}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {alert.productCode}
                    {alert.categoryName ? ` · ${alert.categoryName}` : ""}
                  </span>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col divide-y">
                  {alert.lowVariants.map((v) => (
                    <li key={v.variantId} className="flex items-center justify-between gap-2 py-1.5">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="size-3 shrink-0 rounded-full border border-border" style={{ backgroundColor: v.colorHex }} />
                        <span className="font-semibold">
                          {v.sizeName} / {v.colorName}
                        </span>
                        <span className="truncate font-mono text-xs text-muted-foreground">{v.sku}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className={`tabular-nums ${v.available <= 0 ? "text-destructive" : ""}`}>{v.available} avail.</span>
                        <Badge variant={v.status === "OUT" ? "destructive" : "outline"}>{v.status === "OUT" ? "Out" : `≤ ${v.threshold}`}</Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
