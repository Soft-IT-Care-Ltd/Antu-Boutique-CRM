import { z } from "zod";

import { ReturnsWorkspace } from "@/components/returns/returns-workspace";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";

// PRD §4.11 — returns and exchanges: requests to approve, items on their way
// back, what's done, and the exchange report. Scoped through each case's
// original order (lib/returns/queries.ts), so an executive sees their own.
const initialSchema = z.object({
  view: z.enum(["requested", "approved", "done", "closed", "report"]).optional().catch(undefined),
  type: z.enum(["RETURN", "EXCHANGE"]).optional().catch(undefined),
});

export default async function ReturnsExchangesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await guardPage("/returns-exchanges");
  const initial = initialSchema.parse(await searchParams);
  const [canViewReturn, canViewExchange, canApproveReturn, canApproveExchange, canRequestReturn, canRequestExchange, canCounterExchange] = await Promise.all([
    can(user, "return.view"),
    can(user, "exchange.view"),
    can(user, "return.approve"),
    can(user, "exchange.approve"),
    can(user, "return.create"),
    can(user, "exchange.create"),
    can(user, ["pos.sell", "exchange.create"], "all"),
  ]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-5xl md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Returns &amp; Exchanges</h1>
        <p className="text-sm text-muted-foreground">
          Customer returns and size/colour exchanges. Nothing goes back into stock until Packing has checked the item.
        </p>
      </div>
      <ReturnsWorkspace
        key={JSON.stringify(initial)}
        initial={initial}
        permissions={{ canApproveReturn, canApproveExchange, canRequestReturn, canRequestExchange, canCounterExchange, seesBothTypes: canViewReturn && canViewExchange }}
      />
    </div>
  );
}
