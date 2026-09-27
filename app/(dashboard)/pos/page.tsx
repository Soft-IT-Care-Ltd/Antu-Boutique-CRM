import { PosScreen } from "@/components/pos/pos-screen";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { DrawerError, getDrawerState, getPosCashWalletId } from "@/lib/pos/drawer";
import type { DrawerState } from "@/lib/pos/types";
import { prisma } from "@/lib/prisma";
import { listWalletOptions } from "@/lib/wallets/service";

// PRD §4.7 — the showroom counter. Selling prices and stock only: the POS
// never receives cost (POS_OPERATOR holds no product.cost.view, and every
// /api/pos/* response is stripped server-side anyway).
export default async function PosPage() {
  const user = await guardPage("/pos");
  const [wallets, canSellOutOfStock, canManageDrawer, canExchange] = await Promise.all([
    listWalletOptions(prisma),
    can(user, "order.stock_override"),
    can(user, "pos.drawer"),
    can(user, "exchange.create"),
  ]);

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
        <p className="text-sm text-muted-foreground">Showroom sale — scan or search, take payment, done. Stock leaves the shelf the moment the sale completes.</p>
      </div>
      <PosScreen initialDrawer={initialDrawer} drawerError={drawerError} wallets={wallets} canSellOutOfStock={canSellOutOfStock} canManageDrawer={canManageDrawer} canExchange={canExchange} />
    </div>
  );
}
