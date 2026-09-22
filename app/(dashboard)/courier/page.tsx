import { Truck } from "lucide-react";

import { PlaceholderPage } from "@/components/app-shell/placeholder-page";
import { guardPage } from "@/lib/auth/guard-page";

export default async function CourierPage() {
  await guardPage("/courier");
  return (
    <PlaceholderPage
      title="Courier"
      description="Courier companies, zone charges, Steadfast and COD reconciliation."
      icon={Truck}
      phase="Phase 2"
    />
  );
}
