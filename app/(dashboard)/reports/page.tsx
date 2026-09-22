import { BarChart3 } from "lucide-react";

import { PlaceholderPage } from "@/components/app-shell/placeholder-page";
import { guardPage } from "@/lib/auth/guard-page";

export default async function ReportsPage() {
  await guardPage("/reports");
  return (
    <PlaceholderPage
      title="Reports"
      description="R1–R14 — sales, stock, courier, collection, exchange, P&L and more."
      icon={BarChart3}
      phase="Phase 4"
    />
  );
}
