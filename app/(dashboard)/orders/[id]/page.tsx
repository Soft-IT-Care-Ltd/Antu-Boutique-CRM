import { notFound } from "next/navigation";

import { OrderDetail } from "@/components/orders/order-detail";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { scopedWhere } from "@/lib/auth/scope";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import { prisma } from "@/lib/prisma";
import { canManageOrderImages } from "@/lib/orders/access";
import { loadOrderDetail, serializeOrderDetail } from "@/lib/orders/order-detail";
import { loadShipmentDetail } from "@/lib/courier/queries";
import { listWalletOptions } from "@/lib/wallets/service";

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await guardPage("/orders");
  const { id } = await params;

  const scopedRow = await prisma.order.findFirst({
    where: scopedWhere({ id, deletedAt: null }, user),
    select: { id: true, createdById: true, teamId: true },
  });
  if (!scopedRow) notFound();

  const loaded = await loadOrderDetail(id);
  if (!loaded) notFound();

  const [hasCostAccess, canEdit, canUpdateStatus, canReviewEditRequests, canRecordPayment, canEditPayment, canDeletePayment, canVerifyPayment, canSendToSteadfast, canOverrideCourier, canRequestRefund, canDecideRefund] =
    await Promise.all([
      can(user, "product.cost.view"),
      can(user, "order.edit"),
      can(user, "order.status_update"),
      can(user, "order.edit_after_window"),
      can(user, "payment.create"),
      can(user, "payment.edit"),
      can(user, "payment.delete"),
      can(user, "payment.verify"),
      can(user, "courier.create_shipment"),
      can(user, "order.courier_status_override"),
      can(user, "payment.refund"),
      can(user, "payment.refund_approve"),
    ]);
  // Names only (no balances) — anyone recording a payment picks the wallet it went into.
  const wallets = canRecordPayment || canEditPayment || canRequestRefund ? await listWalletOptions(prisma) : [];
  const canManageImages = canManageOrderImages(user, scopedRow);

  const order = await stripCostFieldsForUser(serializeOrderDetail(loaded), user);
  // Anyone who can open this page already sees the order's money, so COD is shown; courier cost is stripped by role.
  const shipment = await stripCostFieldsForUser(await loadShipmentDetail(id, true), user);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-5xl md:p-6">
      <OrderDetail
        order={order}
        hasCostAccess={hasCostAccess}
        canEdit={canEdit}
        canManageImages={canManageImages}
        canUpdateStatus={canUpdateStatus}
        canReviewEditRequests={canReviewEditRequests}
        canRecordPayment={canRecordPayment}
        canEditPayment={canEditPayment}
        canDeletePayment={canDeletePayment}
        canVerifyPayment={canVerifyPayment}
        canRequestRefund={canRequestRefund}
        canDecideRefund={canDecideRefund}
        wallets={wallets}
        currentUserId={user.id}
        shipment={shipment}
        canSendToSteadfast={canSendToSteadfast}
        canOverrideCourier={canOverrideCourier}
      />
    </div>
  );
}
