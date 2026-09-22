import { Store } from "lucide-react";

import { PlaceholderPage } from "@/components/app-shell/placeholder-page";
import { guardPage } from "@/lib/auth/guard-page";

export default async function PosPage() {
  await guardPage("/pos");
  return (
    <PlaceholderPage
      title="POS"
      description="Fast showroom checkout — cart, discount, payment, cash drawer."
      icon={Store}
      phase="Phase 3"
    />
  );
}
