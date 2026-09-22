import { Users2 } from "lucide-react";

import { PlaceholderPage } from "@/components/app-shell/placeholder-page";
import { guardPage } from "@/lib/auth/guard-page";

export default async function LeadsPage() {
  await guardPage("/leads");
  return (
    <PlaceholderPage
      title="Leads"
      description="Source, status funnel and follow-up reminders."
      icon={Users2}
      phase="Phase 4"
    />
  );
}
