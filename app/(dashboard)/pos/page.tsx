import { PosScreen } from "@/components/pos/pos-screen";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { DrawerError, getDrawerState, getPosCashWalletId } from "@/lib/pos/drawer";
import type { DrawerState } from "@/lib/pos/types";
import { getPosLocation, LocationError } from "@/lib/locations/service";
import { prisma } from "@/lib/prisma";
import { listWalletOptions } from "@/lib/wallets/service";

// PRD §4.7 — the showroom counter. Selling prices and stock only: the POS
// never receives cost (POS_OPERATOR holds no product.cost.view, and every
// /api/pos/* response is stripped server-side anyway).
export default async function PosPage() {
  const user = await guardPage("/pos");
  const [wallets, canManageDrawer, canExchange, showroom] = await Promise.all([
    listWalletOptions(prisma),
    can(user, "pos.drawer"),
    can(user, "exchange.create"),
    // C3 — the showroom whose stock this POS sells (CORRECTIONS.md item 11).
    getPosLocation(prisma, user).catch((error) => {
      if (error instanceof LocationError) return null;
      throw error;
    }),
  ]);
  if (!showroom) {
    return (
      <div className="flex flex-1 flex-col gap-2 p-4 md:p-6">
        <h1 className="text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">POS</h1>
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          You&apos;re not assigned to a showroom with a POS. Ask an Admin to assign you in Settings → Locations.
        </p>
      </div>
    );
  }

  let initialDrawer: DrawerState | null = null;
  let drawerError: string | null = null;
  try {
    initialDrawer = await getDrawerState(prisma, await getPosCashWalletId(prisma));
  } catch (error) {
    if (!(error instanceof DrawerError)) throw error;
    drawerError = error.message;
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">POS</h1>
        <p className="text-sm text-muted-foreground">{showroom.name} — scan or search, take payment, done. Stock leaves {showroom.name}&apos;s shelf the moment the sale completes.</p>
      </div>
      <PosScreen initialDrawer={initialDrawer} drawerError={drawerError} wallets={wallets} showroomName={showroom.name} canManageDrawer={canManageDrawer} canExchange={canExchange} />
    </div>
  );
}
