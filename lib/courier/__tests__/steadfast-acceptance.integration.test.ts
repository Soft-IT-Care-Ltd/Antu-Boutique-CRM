import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- The Steadfast client is ALWAYS mocked: no test may reach Steadfast. ----
vi.mock("@/lib/courier/steadfast/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/courier/steadfast/client")>();
  return {
    ...actual,
    getBalance: vi.fn(),
    createOrder: vi.fn(),
    createBulkOrder: vi.fn(),
    statusByCid: vi.fn(),
    statusByInvoice: vi.fn(),
  };
});

import { can } from "@/lib/auth/permissions";
import { stripCostFieldsForUser } from "@/lib/auth/strip-cost-fields";
import type { SessionUser } from "@/lib/auth/types";
import { testSteadfastConnection } from "@/lib/courier/connection";
import { encryptSecret } from "@/lib/courier/crypto";
import { markKeptItems } from "@/lib/courier/partial-delivery";
import { runSteadfastPoll } from "@/lib/courier/poll";
import { listShipments } from "@/lib/courier/queries";
import { sendOrdersToSteadfast } from "@/lib/courier/send";
import * as steadfast from "@/lib/courier/steadfast/client";
import { handleSteadfastWebhook } from "@/lib/courier/webhook";
import { toNumber } from "@/lib/money";
import { packOrder } from "@/lib/orders/pack";
import { prisma } from "@/lib/prisma";
import { completeConditionCheck, ConditionCheckError } from "@/lib/returns/condition-check";
import { checkDeferredConstraintsNow, inRolledBackTransaction } from "@/lib/test/rollback";

// STEADFAST_INTEGRATION.md §6 acceptance checklist + CORRECTIONS Round 2
// §2.5/§2.6, run against the mocked client. Everything happens inside a
// rolled-back transaction (the stock ledger is append-only), so the dev DB
// is left exactly as it was. Requires `npm run db:seed`.

const sf = vi.mocked(steadfast);
const TOKEN = "test-webhook-token-0123456789abcdefghijklmnop";
const realFetch = globalThis.fetch;

beforeAll(() => {
  // Belt and braces: even an un-mocked code path can't touch the network.
  globalThis.fetch = (() => {
    throw new Error("A real network call was attempted during a Steadfast test");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  vi.clearAllMocks();
});

async function sessionUserFor(phone: string): Promise<SessionUser> {
  const user = await prisma.user.findUniqueOrThrow({ where: { phone }, select: { id: true, teamId: true, role: { select: { name: true } } } });
  return { id: user.id, role: user.role.name, teamId: user.teamId };
}

let seq = 0;
const uniquePhone = () => `019${String(Date.now() % 1e6).padStart(6, "0")}${String(++seq % 100).padStart(2, "0")}`;

async function setupIntegration(tx: Prisma.TransactionClient, opts: { enabled?: boolean } = {}) {
  const courier = await tx.courierCompany.findUniqueOrThrow({ where: { provider: "STEADFAST" } });
  const data = {
    apiKeyEncrypted: encryptSecret("test-api-key"),
    secretKeyEncrypted: encryptSecret("test-secret-key"),
    webhookTokenEncrypted: encryptSecret(TOKEN),
    isEnabled: opts.enabled ?? true,
    pollingMinutes: 15,
  };
  return tx.courierIntegration.upsert({ where: { provider: "STEADFAST" }, create: { provider: "STEADFAST", courierId: courier.id, ...data }, update: data });
}

type PackedOrderOpts = { phone?: string; altPhone?: string | null; lines?: number; qty?: number; deliveryNote?: string | null; internalNote?: string | null; zone?: "INSIDE_CITY" | "OUTSIDE_CITY" };

/** A real PACKED order: reserved at CONFIRMED, then packed through packOrder (SALE_OUT + cost snapshot). */
async function makePackedOrder(tx: Prisma.TransactionClient, opts: PackedOrderOpts = {}) {
  const packer = await tx.user.findUniqueOrThrow({ where: { phone: "01711000005" } });
  const se = await tx.user.findUniqueOrThrow({ where: { phone: "01711000004" } });
  const variants = await tx.productVariant.findMany({ where: { isActive: true, stockQty: { gte: 6 } }, orderBy: { stockQty: "desc" }, take: opts.lines ?? 1 });
  const qty = opts.qty ?? 1;
  const customer = await tx.customer.create({
    data: {
      name: "Test Customer",
      phone: opts.phone ?? uniquePhone(),
      altPhone: opts.altPhone ?? null,
      district: "Dhaka",
      thana: "Mirpur",
      addressDetail: "House 1, Road 2",
      createdById: se.id,
      teamId: se.teamId,
    },
  });
  const courier = await tx.courierCompany.findUniqueOrThrow({ where: { provider: "STEADFAST" }, include: { zones: true } });
  const zone = courier.zones.find((z) => z.zone === (opts.zone ?? "INSIDE_CITY"))!;
  const subtotal = variants.length * qty * 1000;
  const total = subtotal + Number(zone.charge);
  const order = await tx.order.create({
    data: {
      orderNo: `TEST-SF-${Date.now()}-${++seq}`,
      status: "CONFIRMED",
      customerId: customer.id,
      courierId: courier.id,
      courierZoneId: zone.id,
      deliveryCharge: zone.charge,
      subtotal,
      total,
      dueAmount: total,
      deliveryNote: opts.deliveryNote === undefined ? "Call before coming" : opts.deliveryNote,
      internalNote: opts.internalNote === undefined ? "INTERNAL: customer refused COD once" : opts.internalNote,
      createdById: se.id,
      teamId: se.teamId,
      items: { create: variants.map((v) => ({ variantId: v.id, qty, unitPrice: 1000 })) },
    },
    include: { items: true },
  });
  for (const v of variants) await tx.productVariant.update({ where: { id: v.id }, data: { reservedQty: { increment: qty } } });
  await packOrder(tx, { id: order.id, status: "CONFIRMED", items: order.items.map((i) => ({ id: i.id, variantId: i.variantId, qty: i.qty })) }, packer.id);
  return { order, customer };
}

function mockCreateOk(consignmentId: number, trackingCode: string) {
  sf.createOrder.mockImplementationOnce(async (_creds, payload) => ({
    consignment: { consignment_id: consignmentId, invoice: payload.invoice, tracking_code: trackingCode, status: "in_review" },
    raw: { status: 200, message: "Consignment has been created successfully.", consignment: { consignment_id: consignmentId, invoice: payload.invoice, tracking_code: trackingCode, status: "in_review" } },
  }));
}

async function sendOne(tx: Prisma.TransactionClient, orderId: string, consignmentId = 9_000_001, trackingCode = "TRK9000001") {
  const admin = await sessionUserFor("01711000001");
  mockCreateOk(consignmentId, trackingCode);
  const [result] = await sendOrdersToSteadfast(tx, { orderIds: [orderId] }, admin);
  expect(result.ok, result.error).toBe(true);
  return result;
}

const webhook = (tx: Prisma.TransactionClient, body: Record<string, unknown>, token: string | null = TOKEN) =>
  handleSteadfastWebhook(tx, token === null ? null : `Bearer ${token}`, body);

const orderStatus = async (tx: Prisma.TransactionClient, id: string) => (await tx.order.findUniqueOrThrow({ where: { id } })).status;
const historyCount = (tx: Prisma.TransactionClient, id: string) => tx.orderStatusHistory.count({ where: { orderId: id } });

describe("Steadfast acceptance checklist (STEADFAST_INTEGRATION.md §6)", () => {
  it("#1 wrong keys → Test Connection fails gracefully", async () => {
    await inRolledBackTransaction(async (tx) => {
      const integration = await setupIntegration(tx);
      const admin = await sessionUserFor("01711000001");
      sf.getBalance.mockRejectedValueOnce(new steadfast.SteadfastApiError("Unauthorized", 401));
      const res = await testSteadfastConnection(tx, admin.id);
      expect(res).toEqual({ ok: false, error: "Steadfast rejected the API key/secret (Unauthorized)" });
      const after = await tx.courierIntegration.findUniqueOrThrow({ where: { id: integration.id } });
      expect(after.connectedAt).toBeNull();

      sf.getBalance.mockResolvedValueOnce(1234.5);
      expect(await testSteadfastConnection(tx, admin.id)).toEqual({ ok: true, balance: 1234.5 });
      expect(toNumber((await tx.courierIntegration.findUniqueOrThrow({ where: { id: integration.id } })).lastBalance!)).toBe(1234.5);
    });
  }, 60_000);

  it("#2 send 1 PACKED order → HANDED_TO_COURIER with tracking code; rider gets only the delivery note", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const { order } = await makePackedOrder(tx, { lines: 2 });
      const stockBefore = await tx.stockMovement.count();
      await sendOne(tx, order.id, 9_000_002, "TRK9000002");

      expect(await orderStatus(tx, order.id)).toBe("HANDED_TO_COURIER");
      const shipment = await tx.shipment.findUniqueOrThrow({ where: { orderId: order.id } });
      expect(shipment).toMatchObject({ consignmentId: "9000002", trackingCode: "TRK9000002", trackingUrl: "https://steadfast.com.bd/tl/TRK9000002", steadfastStatus: "in_review" });
      expect(shipment.bookedAt).not.toBeNull();
      const lastHistory = await tx.orderStatusHistory.findFirstOrThrow({ where: { orderId: order.id }, orderBy: { createdAt: "desc" } });
      expect(lastHistory).toMatchObject({ fromStatus: "PACKED", toStatus: "HANDED_TO_COURIER" });
      expect(lastHistory.note).toContain("TRK9000002");

      const payload = sf.createOrder.mock.calls[0][1];
      expect(payload.note).toBe("Call before coming");
      expect(JSON.stringify(payload)).not.toContain("INTERNAL");
      expect(payload.item_description).toMatch(/\(.+ \/ .+\) ×1, .+\(.+ \/ .+\) ×1/);
      expect(payload.cod_amount).toBe(toNumber(order.dueAmount));
      // Booking never moves stock — that happened at PACKED.
      expect(await tx.stockMovement.count()).toBe(stockBefore);
      expect(await tx.auditLog.count({ where: { action: "courier.steadfast.send", entityId: order.id } })).toBe(1);
      expect(await tx.shipmentStatusLog.count({ where: { shipmentId: shipment.id, source: "API" } })).toBe(1);
    });
  }, 60_000);

  it("#3 bulk-send 3 orders → per-order results; a rejected one stays PACKED with its claim released", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const admin = await sessionUserFor("01711000001");
      const orders = [await makePackedOrder(tx), await makePackedOrder(tx), await makePackedOrder(tx), await makePackedOrder(tx)].map((o) => o.order);
      sf.createBulkOrder.mockImplementationOnce(async (_creds, payloads) => ({
        items: payloads.map((p, i) =>
          i === 3
            ? { invoice: p.invoice, status: "error", note: "Invalid recipient address" }
            : { invoice: p.invoice, consignment_id: 9_100_000 + i, tracking_code: `BULK${i}`, status: "success" },
        ),
        raw: { status: 200 },
      }));
      const results = await sendOrdersToSteadfast(tx, { orderIds: orders.map((o) => o.id) }, admin);

      expect(sf.createBulkOrder).toHaveBeenCalledTimes(1);
      expect(sf.createOrder).not.toHaveBeenCalled();
      expect(sf.createBulkOrder.mock.calls[0][1]).toHaveLength(4);
      expect(results.filter((r) => r.ok)).toHaveLength(3);
      for (const o of orders.slice(0, 3)) expect(await orderStatus(tx, o.id)).toBe("HANDED_TO_COURIER");
      expect(results[3]).toMatchObject({ ok: false, error: "Invalid recipient address" });
      expect(await orderStatus(tx, orders[3].id)).toBe("PACKED");
      expect(await tx.shipment.findUnique({ where: { orderId: orders[3].id } })).toBeNull();
    });
  }, 90_000);

  it("#4 +8801… phone is normalized and accepted; a 10-digit phone is blocked before anything is sent", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const admin = await sessionUserFor("01711000001");
      const digits = uniquePhone().slice(1); // 1XXXXXXXXX
      const { order: good } = await makePackedOrder(tx, { phone: `+880${digits}`, altPhone: "01812-345678" });
      const { order: bad } = await makePackedOrder(tx, { phone: "0171234567" });
      mockCreateOk(9_200_001, "PHONE1");
      const results = await sendOrdersToSteadfast(tx, { orderIds: [good.id, bad.id] }, admin);

      expect(sf.createOrder).toHaveBeenCalledTimes(1);
      expect(sf.createOrder.mock.calls[0][1]).toMatchObject({ recipient_phone: `0${digits}`, alternative_phone: "01812345678" });
      expect(results.find((r) => r.orderId === good.id)?.ok).toBe(true);
      const blocked = results.find((r) => r.orderId === bad.id)!;
      expect(blocked).toMatchObject({ ok: false, skipped: true });
      expect(blocked.error).toMatch(/11-digit BD mobile/);
      expect(await orderStatus(tx, bad.id)).toBe("PACKED");
    });
  }, 60_000);

  it("#5 webhook with a wrong or missing Bearer token → 401, nothing changes", async () => {
    await inRolledBackTransaction(async (tx) => {
      const integration = await setupIntegration(tx);
      const { order } = await makePackedOrder(tx);
      await sendOne(tx, order.id, 9_300_001);
      const logsBefore = await tx.shipmentStatusLog.count();
      const body = { notification_type: "delivery_status", consignment_id: 9_300_001, status: "pending" };

      expect((await webhook(tx, body, "wrong-token")).status).toBe(401);
      expect((await webhook(tx, body, null)).status).toBe(401);
      expect((await handleSteadfastWebhook(tx, TOKEN, body)).status).toBe(401); // not "Bearer …"
      expect(await orderStatus(tx, order.id)).toBe("HANDED_TO_COURIER");
      expect(await tx.shipmentStatusLog.count()).toBe(logsBefore);
      expect((await tx.courierIntegration.findUniqueOrThrow({ where: { id: integration.id } })).lastWebhookAt).toBeNull();
    });
  }, 60_000);

  it('#6 webhook "pending" → IN_TRANSIT; "Delivered" (capitalised) → DELIVERED, delivery_charge saved as courier cost, COD recorded', async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const { order } = await makePackedOrder(tx);
      await sendOne(tx, order.id, 9_400_001);

      expect((await webhook(tx, { notification_type: "delivery_status", consignment_id: 9_400_001, invoice: order.orderNo, status: "pending" })).body).toMatchObject({ status: "success" });
      expect(await orderStatus(tx, order.id)).toBe("IN_TRANSIT");

      sf.statusByCid.mockResolvedValueOnce({ deliveryStatus: "delivered", raw: { status: 200, delivery_status: "delivered" } });
      const res = await webhook(tx, {
        notification_type: "delivery_status",
        consignment_id: 9_400_001,
        invoice: order.orderNo,
        cod_amount: 1060,
        status: "Delivered",
        delivery_charge: 110,
        tracking_message: "Delivered",
        updated_at: "2026-09-23 12:45:30",
      });
      expect(res).toEqual({ status: 200, body: { status: "success", message: "Webhook received successfully." } });
      expect(sf.statusByCid).toHaveBeenCalledWith(expect.anything(), "9400001");
      expect(await orderStatus(tx, order.id)).toBe("DELIVERED");
      const shipment = await tx.shipment.findUniqueOrThrow({ where: { orderId: order.id } });
      expect(toNumber(shipment.courierCostActual!)).toBe(110);
      expect(toNumber(shipment.codCollected!)).toBe(1060);
      expect(shipment.deliveredAt).not.toBeNull();
      expect(shipment.finalizedAt).not.toBeNull();
      // COD reconciliation queue = delivered, collected, not yet paid out by the courier.
      expect(shipment.codReceivedAt).toBeNull();
    });
  }, 60_000);

  it("#7 webhook cancelled → RETURNED + return condition check opened; the same webhook replayed changes nothing", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const { order } = await makePackedOrder(tx);
      await sendOne(tx, order.id, 9_500_001);
      await webhook(tx, { notification_type: "delivery_status", consignment_id: 9_500_001, status: "pending" });

      sf.statusByCid.mockResolvedValue({ deliveryStatus: "cancelled", raw: {} });
      const cancelled = { notification_type: "delivery_status", consignment_id: 9_500_001, status: "cancelled", delivery_charge: 65 };
      await webhook(tx, cancelled);
      expect(await orderStatus(tx, order.id)).toBe("RETURNED");
      const inspections = await tx.returnInspection.findMany({ where: { orderId: order.id }, include: { lines: true } });
      expect(inspections).toHaveLength(1);
      expect(inspections[0]).toMatchObject({ source: "COURIER_RETURN", status: "PENDING" });
      expect(inspections[0].lines[0].qty).toBe(1);

      const historyBefore = await historyCount(tx, order.id);
      const stockBefore = await tx.stockMovement.count();
      await webhook(tx, cancelled);
      await webhook(tx, cancelled);
      expect(await historyCount(tx, order.id)).toBe(historyBefore);
      expect(await tx.returnInspection.count({ where: { orderId: order.id } })).toBe(1);
      expect(await tx.stockMovement.count()).toBe(stockBefore); // RETURNED alone never restocks
      expect(sf.statusByCid).toHaveBeenCalledTimes(1); // no cross-check once final
    });
  }, 60_000);

  it("#8 tracking_update → shipment timeline (Dhaka time stored as UTC), status unchanged, replay not duplicated", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const { order } = await makePackedOrder(tx);
      await sendOne(tx, order.id, 9_600_001);
      const body = { notification_type: "tracking_update", consignment_id: 9_600_001, invoice: order.orderNo, tracking_message: "Parcel is out for delivery.", updated_at: "2026-09-23 12:45:30" };
      await webhook(tx, body);
      await webhook(tx, body);

      const shipment = await tx.shipment.findUniqueOrThrow({ where: { orderId: order.id }, include: { trackingEvents: true } });
      expect(shipment.trackingEvents).toHaveLength(1);
      // CORRECTIONS Round 2 §2.5: 12:45:30 Asia/Dhaka = 06:45:30 UTC, not 12:45:30Z.
      expect(shipment.trackingEvents[0].eventAt.toISOString()).toBe("2026-09-23T06:45:30.000Z");
      expect(await orderStatus(tx, order.id)).toBe("HANDED_TO_COURIER");
    });
  }, 60_000);

  it("#9 poll fallback: pending → delivered via polling gives the same result as the webhook path, then stops polling", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const { order } = await makePackedOrder(tx);
      await sendOne(tx, order.id, 9_700_001);
      const shipment = await tx.shipment.findUniqueOrThrow({ where: { orderId: order.id } });

      sf.statusByCid.mockResolvedValueOnce({ deliveryStatus: "pending", raw: { status: 200, delivery_status: "pending" } });
      expect(await runSteadfastPoll(tx, { shipmentId: shipment.id, delayMs: 0 })).toMatchObject({ polled: 1, changed: 1, errors: [] });
      expect(await orderStatus(tx, order.id)).toBe("IN_TRANSIT");

      sf.statusByCid.mockResolvedValueOnce({ deliveryStatus: "delivered", raw: { status: 200, delivery_status: "delivered" } });
      await runSteadfastPoll(tx, { shipmentId: shipment.id, delayMs: 0 });
      expect(await orderStatus(tx, order.id)).toBe("DELIVERED");
      const after = await tx.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
      expect(after.finalizedAt).not.toBeNull();
      expect(after.lastPolledAt).not.toBeNull();
      expect(await tx.shipmentStatusLog.count({ where: { shipmentId: shipment.id, source: "POLL" } })).toBe(2);

      // Final → never polled again.
      expect(await runSteadfastPoll(tx, { shipmentId: shipment.id, delayMs: 0 })).toMatchObject({ polled: 0 });
      expect(sf.statusByCid).toHaveBeenCalledTimes(2);
    });
  }, 60_000);

  it("#10 the same order can't be sent twice", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const admin = await sessionUserFor("01711000001");
      const { order } = await makePackedOrder(tx);
      await sendOne(tx, order.id, 9_800_001);
      const [again] = await sendOrdersToSteadfast(tx, { orderIds: [order.id] }, admin);
      expect(again).toMatchObject({ ok: false, skipped: true });
      expect(again.error).toMatch(/Already sent to Steadfast \(consignment 9800001\)/);
      expect(sf.createOrder).toHaveBeenCalledTimes(1);
      // …and the database enforces it too: one shipment per order.
      await expect(tx.$queryRaw`SELECT 1 FROM "shipments" WHERE "orderId" = ${order.id}`).resolves.toHaveLength(1);
    });
  }, 60_000);
});

describe("CORRECTIONS Round 2 §2.6 — approval-pending stage is never skipped", () => {
  it("webhook 'delivered' while the API says delivered_approval_pending → stays IN_TRANSIT with that sub-status; the poll finalizes it later", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const { order } = await makePackedOrder(tx);
      await sendOne(tx, order.id, 9_900_001);
      await webhook(tx, { notification_type: "delivery_status", consignment_id: 9_900_001, status: "pending" });

      sf.statusByCid.mockResolvedValueOnce({ deliveryStatus: "delivered_approval_pending", raw: {} });
      await webhook(tx, { notification_type: "delivery_status", consignment_id: 9_900_001, status: "delivered", delivery_charge: 60 });
      expect(await orderStatus(tx, order.id)).toBe("IN_TRANSIT");
      let shipment = await tx.shipment.findUniqueOrThrow({ where: { orderId: order.id } });
      expect(shipment).toMatchObject({ subStatus: "DELIVERY_APPROVAL_PENDING", steadfastStatus: "delivered_approval_pending", needsAttention: false, finalizedAt: null });
      const log = await tx.shipmentStatusLog.findFirstOrThrow({ where: { shipmentId: shipment.id, source: "WEBHOOK" }, orderBy: { receivedAt: "desc" } });
      expect(log.rawPayload).toMatchObject({ status: "delivered", status_api_cross_check: "delivered_approval_pending" });

      sf.statusByCid.mockResolvedValueOnce({ deliveryStatus: "delivered", raw: {} });
      await runSteadfastPoll(tx, { shipmentId: shipment.id, delayMs: 0 });
      expect(await orderStatus(tx, order.id)).toBe("DELIVERED");
      shipment = await tx.shipment.findUniqueOrThrow({ where: { orderId: order.id } });
      expect(shipment.subStatus).toBeNull();
    });
  }, 60_000);

  it("webhook 'cancelled' with the status API unreachable → held at return-approval-pending and flagged, never RETURNED on trust", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const { order } = await makePackedOrder(tx);
      await sendOne(tx, order.id, 9_900_002);
      sf.statusByCid.mockRejectedValueOnce(new steadfast.SteadfastApiError("Steadfast unreachable on /status_by_cid: timeout"));
      await webhook(tx, { notification_type: "delivery_status", consignment_id: 9_900_002, status: "cancelled" });

      // HANDED_TO_COURIER → IN_TRANSIT (hold), not RETURNED.
      expect(await orderStatus(tx, order.id)).toBe("IN_TRANSIT");
      let shipment = await tx.shipment.findUniqueOrThrow({ where: { orderId: order.id } });
      expect(shipment).toMatchObject({ subStatus: "RETURN_APPROVAL_PENDING", needsAttention: true });
      expect(shipment.attentionReason).toMatch(/could not confirm/);
      expect(await tx.returnInspection.count({ where: { orderId: order.id } })).toBe(0);

      sf.statusByCid.mockResolvedValueOnce({ deliveryStatus: "cancelled", raw: {} });
      await runSteadfastPoll(tx, { shipmentId: shipment.id, delayMs: 0 });
      expect(await orderStatus(tx, order.id)).toBe("RETURNED");
      shipment = await tx.shipment.findUniqueOrThrow({ where: { orderId: order.id } });
      expect(shipment.needsAttention).toBe(false);
    });
  }, 60_000);

  it("a courier that skips 'pending' still produces a legal, step-by-step history (HANDED → IN_TRANSIT → DELIVERED)", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const { order } = await makePackedOrder(tx);
      await sendOne(tx, order.id, 9_900_003);
      sf.statusByCid.mockResolvedValueOnce({ deliveryStatus: "delivered", raw: {} });
      await webhook(tx, { notification_type: "delivery_status", consignment_id: 9_900_003, status: "delivered" });
      const steps = await tx.orderStatusHistory.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" }, select: { toStatus: true, changedById: true } });
      expect(steps.map((s) => s.toStatus).slice(-2)).toEqual(["IN_TRANSIT", "DELIVERED"]);
      expect(steps.at(-1)!.changedById).toBeNull(); // "System"
    });
  }, 60_000);
});

describe("partial delivery + the reusable condition check", () => {
  it("partial_delivered → PARTIAL_DELIVERED, flagged for Accounts; kept items recompute the total; the rest is condition-checked", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const packer = await sessionUserFor("01711000005");
      const { order } = await makePackedOrder(tx, { lines: 2 });
      await sendOne(tx, order.id, 9_950_001);
      await webhook(tx, { notification_type: "delivery_status", consignment_id: 9_950_001, status: "pending" });
      sf.statusByCid.mockResolvedValueOnce({ deliveryStatus: "partial_delivered", raw: {} });
      await webhook(tx, { notification_type: "delivery_status", consignment_id: 9_950_001, status: "partial_delivered", cod_amount: 1060 });

      expect(await orderStatus(tx, order.id)).toBe("PARTIAL_DELIVERED");
      const shipment = await tx.shipment.findUniqueOrThrow({ where: { orderId: order.id } });
      expect(shipment).toMatchObject({ accountsReviewRequired: true });
      expect(toNumber(shipment.codCollected!)).toBe(1060);
      const inspection = await tx.returnInspection.findFirstOrThrow({ where: { orderId: order.id } });
      expect(inspection).toMatchObject({ source: "PARTIAL_DELIVERY", status: "AWAITING_KEPT_ITEMS" });

      const items = await tx.orderItem.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
      const result = await markKeptItems(tx, { inspectionId: inspection.id, kept: [{ orderItemId: items[0].id, keptQty: 1 }, { orderItemId: items[1].id, keptQty: 0 }] }, packer.id);
      expect(result.returnedUnits).toBe(1);
      const refreshed = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      // Kept one 1,000 line + delivery charge; nothing paid yet → all of it due.
      expect(toNumber(refreshed.total)).toBe(1000 + toNumber(order.deliveryCharge));
      expect(toNumber(refreshed.dueAmount)).toBe(toNumber(refreshed.total));
      expect((await tx.orderItem.findUniqueOrThrow({ where: { id: items[1].id } })).returnedQty).toBe(1);
      await expect(markKeptItems(tx, { inspectionId: inspection.id, kept: [] }, packer.id)).rejects.toThrow(/already been recorded/);

      // Packing: the returned unit is damaged → RETURN_IN then DAMAGE_OUT + an expense at its frozen cost.
      const snapshot = items[1].unitCostSnapshot!;
      const variantBefore = await tx.productVariant.findUniqueOrThrow({ where: { id: items[1].variantId } });
      const check = await completeConditionCheck(tx, { inspectionId: inspection.id, lines: [{ orderItemId: items[1].id, goodQty: 0, damagedQty: 1 }], note: "Torn seam" }, packer.id);
      expect(check).toMatchObject({ restockedUnits: 0, writtenOffUnits: 1, returnChargePosted: null });
      const moves = await tx.stockMovement.findMany({ where: { referenceId: inspection.id }, orderBy: { createdAt: "asc" } });
      expect(moves.map((m) => [m.type, m.qty])).toEqual([["RETURN_IN", 1], ["DAMAGE_OUT", -1]]);
      for (const m of moves) expect(toNumber(m.unitCostSnapshot)).toBe(toNumber(snapshot));
      const expense = await tx.expense.findFirstOrThrow({ where: { stockMovementId: moves[1].id } });
      expect(toNumber(expense.amount)).toBe(toNumber(snapshot));
      expect((await tx.productVariant.findUniqueOrThrow({ where: { id: items[1].variantId } })).stockQty).toBe(variantBefore.stockQty);
      await checkDeferredConstraintsNow(tx); // stock == sum(ledger) still holds
    });
  }, 90_000);

  it("courier return: Good → RETURN_IN restock at the frozen cost, return charge posted once as an expense", async () => {
    await inRolledBackTransaction(async (tx) => {
      await setupIntegration(tx);
      const packer = await sessionUserFor("01711000005");
      const { order } = await makePackedOrder(tx, { qty: 2 });
      await sendOne(tx, order.id, 9_960_001);
      sf.statusByCid.mockResolvedValueOnce({ deliveryStatus: "cancelled", raw: {} });
      await webhook(tx, { notification_type: "delivery_status", consignment_id: 9_960_001, status: "cancelled", delivery_charge: 75 });
      const inspection = await tx.returnInspection.findFirstOrThrow({ where: { orderId: order.id } });
      const [item] = await tx.orderItem.findMany({ where: { orderId: order.id } });
      const before = await tx.productVariant.findUniqueOrThrow({ where: { id: item.variantId } });

      await expect(
        completeConditionCheck(tx, { inspectionId: inspection.id, lines: [{ orderItemId: item.id, goodQty: 1, damagedQty: 0 }] }, packer.id),
      ).rejects.toThrow(ConditionCheckError); // all 2 units must be accounted for

      const res = await completeConditionCheck(tx, { inspectionId: inspection.id, lines: [{ orderItemId: item.id, goodQty: 2, damagedQty: 0 }] }, packer.id);
      expect(res).toEqual({ restockedUnits: 2, writtenOffUnits: 0, returnChargePosted: "75" });
      expect((await tx.productVariant.findUniqueOrThrow({ where: { id: item.variantId } })).stockQty).toBe(before.stockQty + 2);
      const restock = await tx.stockMovement.findFirstOrThrow({ where: { referenceId: inspection.id } });
      expect(restock).toMatchObject({ type: "RETURN_IN", qty: 2, referenceType: "RETURN" });
      expect(toNumber(restock.unitCostSnapshot)).toBe(toNumber(item.unitCostSnapshot!));
      const charge = await tx.expense.findFirstOrThrow({ where: { returnChargeInspectionId: inspection.id }, include: { category: true } });
      expect(charge.category.name).toBe("Courier return charge");
      expect(toNumber(charge.amount)).toBe(75);
      expect(await tx.auditLog.count({ where: { action: "return.condition_check", entityId: order.id } })).toBe(1);

      await expect(
        completeConditionCheck(tx, { inspectionId: inspection.id, lines: [{ orderItemId: item.id, goodQty: 2, damagedQty: 0 }] }, packer.id),
      ).rejects.toThrow(/already been checked/);
      await checkDeferredConstraintsNow(tx);
    });
  }, 60_000);
});

describe("roles: courier data is scoped and cost/money never leaks", () => {
  it("SE and TL have no courier access; Packing can send + check returns but not manage; only Admin edits keys", async () => {
    const roles = {
      admin: await sessionUserFor("01711000001"),
      manager: await sessionUserFor("01711000002"),
      tl: await sessionUserFor("01711000003"),
      se: await sessionUserFor("01711000004"),
      packing: await sessionUserFor("01711000005"),
      accounts: await sessionUserFor("01711000006"),
      pos: await sessionUserFor("01711000007"),
    };
    const courierPerms = ["courier.view", "courier.create_shipment", "courier.reconcile", "courier.manage", "courier.return_check"] as const;
    for (const role of ["se", "tl", "pos"] as const) {
      for (const p of courierPerms) expect(await can(roles[role], p), `${role} ${p}`).toBe(false);
    }
    expect(await can(roles.packing, "courier.create_shipment")).toBe(true);
    expect(await can(roles.packing, "courier.return_check")).toBe(true);
    expect(await can(roles.packing, "courier.manage")).toBe(false);
    expect(await can(roles.accounts, "courier.reconcile")).toBe(true);
    expect(await can(roles.manager, "courier.manage")).toBe(true);
    expect(await can(roles.manager, "settings.manage")).toBe(false);
    expect(await can(roles.admin, "settings.manage")).toBe(true);
    // Overriding a courier-booked order's status by hand is Admin-only.
    for (const [role, user] of Object.entries(roles)) {
      expect(await can(user, "order.courier_status_override"), `${role} courier override`).toBe(role === "admin");
    }
  }, 60_000);

  it("Packing's shipment list has no COD and — after stripping — no courier cost; Admin's has both", async () => {
    const packing = await sessionUserFor("01711000005");
    const admin = await sessionUserFor("01711000001");
    const packingView = await stripCostFieldsForUser(await listShipments(packing, "active", { page: 1, pageSize: 50 }, false), packing);
    const adminView = await stripCostFieldsForUser(await listShipments(admin, "active", { page: 1, pageSize: 50 }, true), admin);
    expect(packingView.items.length).toBeGreaterThan(0);
    const keys = (rows: object[]) => new Set(rows.flatMap((r) => Object.keys(r)));
    for (const k of ["codAmount", "codCollected", "courierCostEstimate", "courierCostActual"]) {
      expect(keys(packingView.items).has(k), `packing sees ${k}`).toBe(false);
      expect(keys(adminView.items).has(k), `admin sees ${k}`).toBe(true);
    }
  }, 60_000);
});
