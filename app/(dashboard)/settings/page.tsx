import { Settings } from "lucide-react";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StoreCreditSettings } from "@/components/settings/store-credit-settings";
import { guardPage } from "@/lib/auth/guard-page";
import { prisma } from "@/lib/prisma";
import { getStoreCreditExpiryDays } from "@/lib/store-credit/ledger";

export default async function SettingsPage() {
  await guardPage("/settings");
  const expiryDays = await getStoreCreditExpiryDays(prisma);
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-3xl md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Business profile, masters, roles and permissions, integrations.</p>
      </div>
      <StoreCreditSettings initialDays={expiryDays} />
      <Card className="border-dashed">
        <CardHeader className="flex-row items-center gap-3 space-y-0">
          <Settings className="size-5 text-muted-foreground" />
          <div>
            <CardTitle className="text-sm">The rest of Settings comes in Phase 5</CardTitle>
            <CardDescription>Business profile, masters, roles and permissions, office hours and integrations.</CardDescription>
          </div>
        </CardHeader>
      </Card>
    </div>
  );
}
