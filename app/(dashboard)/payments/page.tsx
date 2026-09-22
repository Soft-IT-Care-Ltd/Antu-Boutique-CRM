import { Wallet } from "lucide-react";

import { PlaceholderPage } from "@/components/app-shell/placeholder-page";
import { guardPage } from "@/lib/auth/guard-page";

export default async function PaymentsPage() {
  await guardPage("/payments");
  return (
    <PlaceholderPage
      title="Payments & Wallets"
      description="Payment verification, wallet balances and statements."
      icon={Wallet}
      phase="Phase 2"
    />
  );
}
