"use client";

import { CodReconciliation } from "@/components/courier/cod-reconciliation";
import { ReturnsCheck } from "@/components/courier/returns-check";
import { ShipmentList } from "@/components/courier/shipment-list";
import { SteadfastSettings } from "@/components/courier/steadfast-settings";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { WalletOption } from "@/lib/wallets/constants";

export type CourierWorkspaceProps = {
  canViewShipments: boolean;
  canSend: boolean;
  canSync: boolean;
  canReconcile: boolean;
  canCheckReturns: boolean;
  canViewReturns: boolean;
  canSeeIntegration: boolean;
  canEditSettings: boolean;
  canSeeCost: boolean;
  openReturns: number;
  /** Where a courier payout can land (P2.3 wallets). */
  payoutWallets: WalletOption[];
  /** A dashboard link's ?tab= (P4.3) — ignored when this user can't open that tab. */
  initialTab?: CourierTab;
  /** Open the COD tab on parcels past COD_OVERDUE_DAYS only (the owner's alert). */
  codOverdueOnly?: boolean;
};

export type CourierTab = "shipments" | "returns" | "cod" | "steadfast";

// CORRECTIONS Courier §2: the Courier page IS the Steadfast page — shipments,
// the return condition check, and the integration itself. The schema stays
// multi-courier; only Steadfast is shown.
export function CourierWorkspace(props: CourierWorkspaceProps) {
  const allowed: Record<CourierTab, boolean> = { shipments: props.canViewShipments, returns: props.canViewReturns, cod: props.canReconcile, steadfast: props.canSeeIntegration };
  const defaultTab = props.initialTab && allowed[props.initialTab] ? props.initialTab : props.canViewShipments ? "shipments" : props.canViewReturns ? "returns" : "steadfast";
  return (
    <Tabs defaultValue={defaultTab}>
      <TabsList>
        {props.canViewShipments ? <TabsTrigger value="shipments">Shipments</TabsTrigger> : null}
        {props.canViewReturns ? (
          <TabsTrigger value="returns">
            Returns check{props.openReturns > 0 ? <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-[10px] text-white">{props.openReturns}</span> : null}
          </TabsTrigger>
        ) : null}
        {props.canReconcile ? <TabsTrigger value="cod">COD &amp; payouts</TabsTrigger> : null}
        {props.canSeeIntegration ? <TabsTrigger value="steadfast">Steadfast</TabsTrigger> : null}
      </TabsList>
      {props.canViewShipments ? (
        <TabsContent value="shipments" className="pt-4">
          <ShipmentList canSend={props.canSend} canSync={props.canSync} canReconcile={props.canReconcile} />
        </TabsContent>
      ) : null}
      {props.canViewReturns ? (
        <TabsContent value="returns" className="pt-4">
          <ReturnsCheck canCheck={props.canCheckReturns} canMarkKept={props.canCheckReturns || props.canReconcile} />
        </TabsContent>
      ) : null}
      {props.canReconcile ? (
        <TabsContent value="cod" className="pt-4">
          <CodReconciliation canSyncPayouts={props.canReconcile || props.canSync} payoutWallets={props.payoutWallets} initialOverdueOnly={props.codOverdueOnly} />
        </TabsContent>
      ) : null}
      {props.canSeeIntegration ? (
        <TabsContent value="steadfast" className="pt-4">
          <SteadfastSettings canEditSettings={props.canEditSettings} canManage={props.canSync} canSeeCost={props.canSeeCost} />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}
