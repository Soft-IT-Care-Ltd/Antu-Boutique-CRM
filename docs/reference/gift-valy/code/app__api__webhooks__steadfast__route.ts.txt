import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  getSteadfastIntegration,
  credsFromIntegration,
  verifyWebhookToken,
  bearerFromHeader,
} from "@/lib/steadfast-integration";
import {
  mapSteadfastStatus,
  parseSteadfastTimestamp,
  resolveFinalWebhookStatus,
} from "@/lib/steadfast-constants";
import { statusByCid, statusByInvoice } from "@/lib/steadfast";
import {
  ingestDeliveryStatus,
  ingestTrackingUpdate,
  logUnmatchedStatus,
  shipmentForSyncInclude,
  type ShipmentForSync,
} from "@/lib/steadfast-sync";

// Inbound webhook receiver (STEADFAST_INTEGRATION.md §3A). Bearer-authenticated;
// primary real-time status/tracking source. Status changes route through the
// SAME status-update code path as manual updates (ingestDeliveryStatus →
// applyShipmentStatus), so COD reconciliation and the return flow trigger
// identically. Idempotent, and it never crashes the app (§5).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OK = { status: "success", message: "Webhook received successfully." };

// Resolve the shipment by Steadfast consignment_id, falling back to invoice =
// order_no (§3A step 1).
async function findShipment(
  consignmentId: unknown,
  invoice: unknown
): Promise<(ShipmentForSync & Record<string, unknown>) | null> {
  const cid =
    consignmentId != null && !Number.isNaN(Number(consignmentId))
      ? BigInt(Number(consignmentId))
      : null;
  if (cid != null) {
    const s = await prisma.shipment.findUnique({
      where: { consignmentId: cid },
      include: shipmentForSyncInclude,
    });
    if (s) return s as unknown as ShipmentForSync & Record<string, unknown>;
  }
  if (typeof invoice === "string" && invoice.trim()) {
    const s = await prisma.shipment.findFirst({
      where: { order: { orderNo: invoice.trim() } },
      include: shipmentForSyncInclude,
    });
    if (s) return s as unknown as ShipmentForSync & Record<string, unknown>;
  }
  return null;
}

export async function POST(req: Request) {
  // 1. AUTH FIRST — a bad/missing Bearer returns 401 before any DB write
  //    (acceptance #5: wrong/missing token → 401, nothing changes).
  const integration = await getSteadfastIntegration();
  const presented = bearerFromHeader(req.headers.get("authorization"));
  if (!verifyWebhookToken(integration, presented)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Parse body (malformed JSON → 400, still no side effects).
  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    // Health signal: a webhook was received and authenticated (§3A settings).
    await prisma.courierIntegration.update({
      where: { id: integration!.id },
      data: { lastWebhookAt: new Date() },
    });

    const notificationType = String(payload.notification_type ?? "");

    if (notificationType === "delivery_status") {
      const shipment = await findShipment(payload.consignment_id, payload.invoice);
      if (!shipment) {
        await logUnmatchedStatus(
          prisma as unknown as Prisma.TransactionClient,
          payload,
          payload.status != null ? String(payload.status) : null,
          "WEBHOOK"
        );
        return NextResponse.json(
          { status: "error", message: "Invalid consignment ID." },
          { status: 200 }
        );
      }
      const deliveryCharge =
        payload.delivery_charge != null && !Number.isNaN(Number(payload.delivery_charge))
          ? Number(payload.delivery_charge)
          : null;

      // Round 2 §2.6 — Steadfast's webhook says "delivered"/"cancelled" the
      // moment the RIDER marks the parcel, while hub approval (when the COD
      // actually enters our balance) can still be pending — and the status API
      // is the source that distinguishes the two. Cross-check it BEFORE the
      // transaction (network never inside a tx, §5): an *_approval_pending
      // answer holds the order In Transit under the matching approval sub-tab;
      // agreement, an older status, or an unreachable API trusts the webhook.
      const webhookStatus = String(payload.status ?? "");
      let effectiveStatus = webhookStatus;
      let crossChecked: string | null = null;
      const mapped = mapSteadfastStatus(webhookStatus);
      if (mapped.to === "DELIVERED" || mapped.to === "RETURNED") {
        try {
          const creds = credsFromIntegration(integration);
          const cid = (shipment as { consignmentId?: bigint | null }).consignmentId;
          const res =
            cid != null
              ? await statusByCid(creds, cid)
              : await statusByInvoice(
                  creds,
                  String(payload.invoice ?? "").trim()
                );
          crossChecked = res.deliveryStatus;
          effectiveStatus = resolveFinalWebhookStatus(webhookStatus, crossChecked);
        } catch {
          // Keys unset / API down — behave exactly as before the cross-check.
        }
      }

      await prisma.$transaction((tx) =>
        ingestDeliveryStatus(tx, {
          shipment,
          rawStatus: effectiveStatus,
          source: "WEBHOOK",
          // Keep the audit honest: the payload is logged verbatim, plus what
          // the status API said when it overruled the webhook's status.
          rawPayload:
            crossChecked != null && effectiveStatus !== webhookStatus
              ? { ...payload, status_api_cross_check: crossChecked }
              : payload,
          deliveryCharge,
        })
      );
      return NextResponse.json(OK, { status: 200 });
    }

    if (notificationType === "tracking_update") {
      const shipment = await findShipment(payload.consignment_id, payload.invoice);
      if (!shipment) {
        await logUnmatchedStatus(
          prisma as unknown as Prisma.TransactionClient,
          payload,
          null,
          "WEBHOOK"
        );
        return NextResponse.json(OK, { status: 200 });
      }
      // Round 2 §2.5 — updated_at is Asia/Dhaka local with no zone marker
      // (verified in production: it runs exactly +6h ahead of arrival when
      // read as UTC). Parse it as Dhaka; store UTC.
      const eventAt = parseSteadfastTimestamp(payload.updated_at) ?? new Date();
      await prisma.$transaction((tx) =>
        ingestTrackingUpdate(tx, {
          shipmentId: shipment.id,
          message: String(payload.tracking_message ?? "").slice(0, 1000),
          eventAt,
          source: "WEBHOOK",
        })
      );
      return NextResponse.json(OK, { status: 200 });
    }

    // Unknown notification_type → log, respond 200 (never crash, §3A).
    await logUnmatchedStatus(
      prisma as unknown as Prisma.TransactionClient,
      payload,
      null,
      "WEBHOOK"
    );
    return NextResponse.json(OK, { status: 200 });
  } catch (e) {
    // Unexpected server error — log and 500 so Steadfast retries (safe: idempotent).
    console.error("Steadfast webhook processing error:", e);
    return NextResponse.json(
      { status: "error", message: "Processing error" },
      { status: 500 }
    );
  }
}
