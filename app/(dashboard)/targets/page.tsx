import { Trophy } from "lucide-react";

import { PlaceholderPage } from "@/components/app-shell/placeholder-page";
import { guardPage } from "@/lib/auth/guard-page";

export default async function TargetsPage() {
  await guardPage("/targets");
  return (
    <PlaceholderPage
      title="Targets & Leaderboard"
      description="Monthly targets, reward rules and the SE leaderboard."
      icon={Trophy}
      phase="Phase 4"
    />
  );
}
