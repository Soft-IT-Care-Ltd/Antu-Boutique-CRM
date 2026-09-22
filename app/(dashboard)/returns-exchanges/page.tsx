import { Repeat2 } from "lucide-react";

import { PlaceholderPage } from "@/components/app-shell/placeholder-page";
import { guardPage } from "@/lib/auth/guard-page";

export default async function ReturnsExchangesPage() {
  await guardPage("/returns-exchanges");
  return (
    <PlaceholderPage
      title="Returns & Exchanges"
      description="Return/refund flow and linked size or colour exchanges."
      icon={Repeat2}
      phase="Phase 3"
    />
  );
}
