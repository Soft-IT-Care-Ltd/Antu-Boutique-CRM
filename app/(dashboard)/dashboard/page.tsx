import { BarChart3, PackageCheck, ShoppingBag, Wallet } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBDT } from "@/lib/money";

const statCards = [
  { label: "Today's orders", value: "0", icon: ShoppingBag },
  { label: "Today's collection", value: formatBDT(0), icon: Wallet },
  { label: "In packing queue", value: "0", icon: PackageCheck },
  { label: "This month", value: formatBDT(0), icon: BarChart3 },
];

export default function DashboardPage() {
  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          The owner&apos;s 10-second view of the business — live once Phase 1 lands.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statCards.map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {stat.label}
              </CardTitle>
              <stat.icon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-dashed">
        <CardHeader>
          <CardTitle>No data yet</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Seed data and the sales engine land in Phase 1. This screen wires up the real
          numbers — leads → orders → packed → delivered — and the 30-day charts once
          there is something to show.
        </CardContent>
      </Card>
    </div>
  );
}
