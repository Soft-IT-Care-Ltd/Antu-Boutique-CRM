import Link from "next/link";
import { Store } from "lucide-react";

import { DrawerHistory } from "@/components/pos/drawer-history";
import { DrawerPanel } from "@/components/pos/drawer-panel";
import { Button } from "@/components/ui/button";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { listExpenseCategories } from "@/lib/expenses/queries";
import { DrawerError, getDrawerState, getPosCashWalletId } from "@/lib/pos/drawer";
import { prisma } from "@/lib/prisma";
import { listWalletOptions } from "@/lib/wallets/service";

// PRD §4.7 — the daily showroom cash drawer and its end-of-day
// reconciliation. POS staff (pos.drawer) open, record and close it; Accounts
// (wallet.view) can read every day's count.
export default async function CashDrawerPage() {
  const user = await guardPage("/pos/drawer");
  const [canManage, canSell] = await Promise.all([can(user, "pos.drawer"), can(user, "pos.sell")]);

  let data: { state: Awaited<ReturnType<typeof getDrawerState>>; wallets: Awaited<ReturnType<typeof listWalletOptions>>; categories: Awaited<ReturnType<typeof listExpenseCategories>> } | null = null;
  let setupError: string | null = null;
  try {
    const [state, wallets, categories] = await Promise.all([
      getDrawerState(prisma, await getPosCashWalletId(prisma)),
      listWalletOptions(prisma),
      canManage ? listExpenseCategories(prisma) : Promise.resolve([]),
    ]);
    data = { state, wallets, categories };
  } catch (error) {
    if (!(error instanceof DrawerError)) throw error;
    setupError = error.message;
  }

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cash drawer</h1>
          <p className="text-sm text-muted-foreground">Opening count, cash sales, cash out, and the day-end count — the Showroom Cash wallet, counted.</p>
        </div>
        {canSell ? (
          <Button render={<Link href="/pos" />} nativeButton={false} variant="outline" className="h-10">
            <Store />
            Back to POS
          </Button>
        ) : null}
      </div>
      {data ? (
        <DrawerPanel initial={data.state} canManage={canManage} wallets={data.wallets} categories={data.categories.filter((c) => !c.isSystem)} />
      ) : (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{setupError}</p>
      )}
      <DrawerHistory />
    </div>
  );
}
