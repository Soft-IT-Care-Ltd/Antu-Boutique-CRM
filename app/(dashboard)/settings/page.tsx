import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Building2, DatabaseBackup, FileUp, KeyRound, Package, Settings2, Shirt, Trophy, Truck, UsersRound, Wallet } from "lucide-react";

import { AdAllocationSettings } from "@/components/settings/ad-allocation-settings";
import { BusinessProfileSettings } from "@/components/settings/business-profile-settings";
import { CourierSettings } from "@/components/settings/courier-settings";
import { ImportSettings } from "@/components/settings/import-settings";
import { OfficeHoursSettings } from "@/components/settings/office-hours-settings";
import { OperationsSettings } from "@/components/settings/operations-settings";
import { PaymentMethodsSettings } from "@/components/settings/payment-methods-settings";
import { RolesSettings } from "@/components/settings/roles-settings";
import { SettingsNav, type SettingsSectionLink } from "@/components/settings/settings-nav";
import { StoreCreditSettings } from "@/components/settings/store-credit-settings";
import { SystemStatusCard } from "@/components/settings/system-status-card";
import { UsersSettings } from "@/components/settings/users-settings";
import { CatalogMasters } from "@/components/settings/catalog-masters";
import { SteadfastSettings } from "@/components/courier/steadfast-settings";
import { RewardRulesCard } from "@/components/targets/rewards-view";
import { Button } from "@/components/ui/button";
import { WalletsOverview } from "@/components/wallets/wallets-overview";
import { getOfficeHours } from "@/lib/attendance/settings";
import { guardPage } from "@/lib/auth/guard-page";
import type { PermissionKey } from "@/lib/auth/permission-definitions";
import { getEffectivePermissions } from "@/lib/auth/permissions";
import { getAdAllocationMethod } from "@/lib/expenses/ad-allocation";
import { getEnabledPaymentMethods } from "@/lib/payments/methods";
import { prisma } from "@/lib/prisma";
import { getBusinessProfile } from "@/lib/settings/business-profile";
import { getOperationsSettings } from "@/lib/settings/operations";
import { listRolesWithPermissions, listTeams } from "@/lib/settings/staff";
import { getStoreCreditExpiryDays } from "@/lib/store-credit/ledger";
import { getBackupHealth, getJobStatuses } from "@/lib/system/jobs";
import { listRules } from "@/lib/targets/rewards";

export const dynamic = "force-dynamic";

// PRD §4.17 Settings (Admin only — the route needs settings.manage). One
// screen, one section at a time (?section=). Sections that change people or
// permissions also need that permission, and each API route checks its own.

type SectionId = "profile" | "catalog" | "couriers" | "steadfast" | "money" | "operations" | "targets" | "users" | "roles" | "import" | "system";

const SECTIONS: (Omit<SettingsSectionLink, "icon"> & { id: SectionId; icon: LucideIcon; title: string; description: string })[] = [
  { id: "profile", label: "Business profile", icon: Building2, title: "Business profile", description: "The name, logo, address and footer printed on invoices, packing slips and showroom receipts." },
  { id: "catalog", label: "Catalog masters", icon: Shirt, title: "Categories, sizes & colours", description: "The master lists every product picks from — one spelling of each." },
  { id: "couriers", label: "Couriers & zones", icon: Truck, title: "Couriers & zone charges", description: "Who delivers, and what the customer is charged per zone." },
  { id: "steadfast", label: "Steadfast", icon: Package, title: "Steadfast integration", description: "API credentials, the webhook URL and token, status sync and what we pay per parcel." },
  { id: "money", label: "Payments & wallets", icon: Wallet, title: "Payments & wallets", description: "Payment methods staff can pick, wallets and their opening balances, ad-cost allocation and store credit." },
  { id: "operations", label: "Orders, stock & hours", icon: Settings2, title: "Orders, stock & office hours", description: "The edit window, packing SLA, low-stock default and the office-hour rules attendance runs on." },
  { id: "targets", label: "Targets & rewards", icon: Trophy, title: "Targets & reward rules", description: "What hitting a target earns. Monthly targets themselves are set on the Targets screen." },
  { id: "users", label: "Users & teams", icon: UsersRound, title: "Users & teams", description: "Staff accounts, their roles and teams, password resets and per-person permissions." },
  { id: "roles", label: "Roles & permissions", icon: KeyRound, title: "Roles & permissions", description: "What each role can do. A change applies to everyone in the role straight away." },
  { id: "import", label: "Import opening data", icon: FileUp, title: "Import opening data", description: "Products with their sizes, colours and opening stock; customers; wallet opening balances — from a CSV." },
  { id: "system", label: "Backups & jobs", icon: DatabaseBackup, title: "Backups & nightly jobs", description: "When the backup and the scheduled jobs last ran, and whether they worked." },
];

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await guardPage("/settings");
  const permissions = await getEffectivePermissions(user.id);
  const has = (key: PermissionKey) => permissions.has(key);

  const allowed = SECTIONS.filter((s) => (s.id === "users" ? has("user.view") : s.id === "roles" ? has("permission.manage") : true));
  const requested = (await searchParams).section;
  const section = allowed.find((s) => s.id === requested) ?? allowed[0];

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-6xl md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Business profile, masters, money, people and permissions, integrations and go-live data.</p>
      </div>
      <div className="flex min-w-0 flex-col gap-4 md:flex-row md:items-start md:gap-6">
        <div className="md:sticky md:top-4 md:w-52 md:shrink-0">
          <SettingsNav sections={allowed.map(({ id, label, icon: Icon }) => ({ id, label, icon: <Icon className="size-4 shrink-0" /> }))} active={section.id} />
        </div>
        <section className="flex min-w-0 flex-1 flex-col gap-4" aria-labelledby="settings-section-title">
          <div>
            <h2 id="settings-section-title" className="text-lg font-semibold">
              {section.title}
            </h2>
            <p className="text-sm text-muted-foreground">{section.description}</p>
          </div>
          <SectionBody id={section.id} has={has} currentUserId={user.id} />
        </section>
      </div>
    </div>
  );
}

async function SectionBody({ id, has, currentUserId }: { id: SectionId; has: (key: PermissionKey) => boolean; currentUserId: string }) {
  switch (id) {
    case "profile":
      return <BusinessProfileSettings initial={await getBusinessProfile(prisma)} />;
    case "catalog":
      return <CatalogMasters canManage={has("catalog.manage")} />;
    case "couriers":
      return <CourierSettings />;
    case "steadfast":
      return <SteadfastSettings canEditSettings canManage={has("courier.manage")} canSeeCost={has("product.cost.view")} />;
    case "money": {
      const [enabled, method, expiryDays] = await Promise.all([getEnabledPaymentMethods(prisma), getAdAllocationMethod(prisma), getStoreCreditExpiryDays(prisma)]);
      return (
        <>
          <PaymentMethodsSettings initial={enabled} />
          {has("wallet.view") ? <WalletsOverview canEntry={has("wallet.entry")} canManage={has("wallet.manage")} /> : null}
          <AdAllocationSettings initial={method} />
          <StoreCreditSettings initialDays={expiryDays} />
        </>
      );
    }
    case "operations": {
      const [operations, officeHours] = await Promise.all([getOperationsSettings(prisma), getOfficeHours(prisma)]);
      return (
        <>
          <OperationsSettings initial={operations} />
          <OfficeHoursSettings initial={officeHours} />
        </>
      );
    }
    case "targets": {
      const canManage = has("target.manage");
      return (
        <>
          <RewardRulesCard rules={await listRules(prisma, { includeInactive: canManage })} canManage={canManage} />
          <div>
            <Button variant="outline" size="sm" render={<Link href="/targets" />} nativeButton={false}>
              <Trophy />
              Set this month&apos;s targets
            </Button>
          </div>
        </>
      );
    }
    case "users": {
      const [teams, roles] = await Promise.all([listTeams(prisma), prisma.role.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, name: true, label: true } })]);
      return (
        <UsersSettings
          teams={teams}
          roles={roles}
          currentUserId={currentUserId}
          canCreate={has("user.create")}
          canEdit={has("user.edit")}
          canDeactivate={has("user.delete")}
          canManagePermissions={has("permission.manage")}
        />
      );
    }
    case "roles":
      return <RolesSettings initialRoles={await listRolesWithPermissions(prisma)} />;
    case "import":
      return <ImportSettings canProducts={has("product.create") && has("product.cost.view")} canCustomers={has("customer.create")} canWallets={has("wallet.manage")} />;
    case "system": {
      const [backup, jobs] = await Promise.all([getBackupHealth(prisma), getJobStatuses(prisma)]);
      return <SystemStatusCard backup={backup} jobs={jobs} />;
    }
  }
}
