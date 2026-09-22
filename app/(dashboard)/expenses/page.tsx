import { Receipt } from "lucide-react";

import { PlaceholderPage } from "@/components/app-shell/placeholder-page";
import { guardPage } from "@/lib/auth/guard-page";

export default async function ExpensesPage() {
  await guardPage("/expenses");
  return (
    <PlaceholderPage
      title="Expenses"
      description="Daily expenses by category, fixed vs variable."
      icon={Receipt}
      phase="Phase 2"
    />
  );
}
