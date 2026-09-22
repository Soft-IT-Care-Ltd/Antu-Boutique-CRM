import { Settings } from "lucide-react";

import { PlaceholderPage } from "@/components/app-shell/placeholder-page";
import { guardPage } from "@/lib/auth/guard-page";

export default async function SettingsPage() {
  await guardPage("/settings");
  return (
    <PlaceholderPage
      title="Settings"
      description="Business profile, masters, roles and permissions, integrations."
      icon={Settings}
      phase="Phase 5"
    />
  );
}
