import { CourierWorkspace } from "@/components/courier/courier-workspace";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { scopedWhere } from "@/lib/auth/scope";
import { prisma } from "@/lib/prisma";

export default async function CourierPage() {
  const user = await guardPage("/courier");
  const [canViewShipments, canSend, canSync, canReconcile, canCheckReturns, canEditSettings, canSeeCost] = await Promise.all([
    can(user, ["courier.view", "courier.create_shipment", "courier.reconcile", "courier.manage"]),
    can(user, "courier.create_shipment"),
    can(user, "courier.manage"),
    can(user, "courier.reconcile"),
    can(user, "courier.return_check"),
    can(user, "settings.manage"),
    can(user, "product.cost.view"),
  ]);
  const canViewReturns = canCheckReturns || canReconcile || canSync;
  const openReturns = canViewReturns
    ? await prisma.returnInspection.count({ where: { status: { not: "COMPLETED" }, order: scopedWhere({ deletedAt: null }, user) } })
    : 0;

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Courier</h1>
        <p className="text-sm text-muted-foreground">Steadfast bookings, parcel tracking, returns coming back, and the integration itself.</p>
      </div>
      <CourierWorkspace
        canViewShipments={canViewShipments}
        canSend={canSend}
        canSync={canSync}
        canReconcile={canReconcile}
        canCheckReturns={canCheckReturns}
        canViewReturns={canViewReturns}
        canSeeIntegration={canSync || canEditSettings}
        canEditSettings={canEditSettings}
        canSeeCost={canSeeCost}
        openReturns={openReturns}
      />
    </div>
  );
}
