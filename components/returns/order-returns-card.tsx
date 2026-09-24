"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Repeat2, Store, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CaseRequestDialog } from "@/components/returns/case-request-dialog";
import { CounterExchangeDialog } from "@/components/returns/counter-exchange-dialog";
import { ReturnCaseCard, type CaseActions } from "@/components/returns/return-case-card";
import { ApiError, fetchJson } from "@/lib/orders/client";
import { RETURN_CASE_MODE_LABELS, RETURN_CASE_STATUS_LABELS, RETURN_REASON_LABELS } from "@/lib/returns/constants";
import type { OrderReturnInfo } from "@/lib/returns/types";

export type ReturnPermissions = {
  canRequestReturn: boolean;
  canRequestExchange: boolean;
  canApproveReturn: boolean;
  canApproveExchange: boolean;
  /** pos.sell + exchange.create: showroom staff. */
  canCounterExchange: boolean;
};

// PRD §4.11 on the order screen: "both orders show the link and the
// reason". Lists this order's returns/exchanges and, on a replacement, the
// exchange it came from; offers Return / Exchange once the customer has the goods.
export function OrderReturnsCard({ orderId, orderNo, permissions }: { orderId: string; orderNo: string; permissions: ReturnPermissions }) {
  const router = useRouter();
  const [info, setInfo] = useState<OrderReturnInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [dialog, setDialog] = useState<"RETURN" | "EXCHANGE" | "COUNTER" | null>(null);

  useEffect(() => {
    fetchJson<{ info: OrderReturnInfo }>(`/api/returns/order/${orderId}`)
      .then(({ info: loaded }) => setInfo(loaded))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load returns."));
  }, [orderId, reloadKey]);

  function changed() {
    setReloadKey((k) => k + 1);
    // Totals, status and payments on the rest of the page move with it.
    router.refresh();
  }

  const actions: CaseActions = {
    canApprove: (c) => (c.type === "EXCHANGE" ? permissions.canApproveExchange : permissions.canApproveReturn),
    canRequest: (c) => (c.type === "EXCHANGE" ? permissions.canRequestExchange : permissions.canRequestReturn),
  };

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!info) return <Skeleton className="h-24 w-full" />;

  const anyReturnable = info.returnableStatus && info.items.some((i) => i.returnable > 0);
  const offerReturn = anyReturnable && permissions.canRequestReturn;
  const offerExchange = anyReturnable && permissions.canRequestExchange && info.hasCustomer;
  const offerCounter = anyReturnable && permissions.canCounterExchange;
  if (info.cases.length === 0 && !info.exchangedFrom && !offerReturn && !offerExchange && !offerCounter) return null;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle>Returns &amp; exchanges</CardTitle>
        <div className="flex flex-wrap gap-2">
          {offerExchange ? (
            <Button size="sm" variant="outline" onClick={() => setDialog("EXCHANGE")}>
              <Repeat2 />
              Exchange
            </Button>
          ) : null}
          {offerCounter ? (
            <Button size="sm" variant="outline" onClick={() => setDialog("COUNTER")}>
              <Store />
              Exchange at counter
            </Button>
          ) : null}
          {offerReturn ? (
            <Button size="sm" variant="outline" onClick={() => setDialog("RETURN")}>
              <Undo2 />
              Return
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {info.exchangedFrom ? (
          <p className="rounded-md border border-dashed p-2.5 text-sm">
            Replacement for{" "}
            <Link href={`/orders/${info.exchangedFrom.orderId}`} className="font-mono font-medium hover:underline">
              {info.exchangedFrom.orderNo}
            </Link>{" "}
            — exchanged {RETURN_CASE_MODE_LABELS[info.exchangedFrom.mode].toLowerCase()} because: <b>{RETURN_REASON_LABELS[info.exchangedFrom.reason]}</b>
            {info.exchangedFrom.reasonNote ? ` (${info.exchangedFrom.reasonNote})` : ""} · {RETURN_CASE_STATUS_LABELS[info.exchangedFrom.status].toLowerCase()}
          </p>
        ) : null}
        {info.cases.map((c) => (
          <ReturnCaseCard key={c.id} returnCase={c} actions={actions} onChanged={changed} showOrder={false} />
        ))}
        {info.cases.length === 0 && !info.exchangedFrom ? <p className="text-sm text-muted-foreground">No returns or exchanges on this order.</p> : null}
      </CardContent>

      {dialog === "RETURN" || dialog === "EXCHANGE" ? (
        <CaseRequestDialog
          type={dialog}
          orderId={orderId}
          orderNo={orderNo}
          items={info.items}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            changed();
          }}
        />
      ) : null}
      {dialog === "COUNTER" ? <CounterExchangeDialog initialOrderNo={orderNo} onClose={() => setDialog(null)} onDone={changed} /> : null}
    </Card>
  );
}
