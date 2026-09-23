import type { Prisma } from "@prisma/client";
import { expect, vi } from "vitest";

import type { SessionUser } from "@/lib/auth/types";
import { encryptSecret } from "@/lib/courier/crypto";
import { sendOrdersToSteadfast } from "@/lib/courier/send";
import * as steadfast from "@/lib/courier/steadfast/client";
import { handleSteadfastWebhook } from "@/lib/courier/webhook";
import { packOrder } from "@/lib/orders/pack";
import { prisma } from "@/lib/prisma";

// Shared fixtures for the courier integration suites. The importing test
// file MUST vi.mock("@/lib/courier/steadfast/client") — these helpers drive
// the mocked functions and never reach Steadfast.

export const TOKEN = "test-webhook-token-0123456789abcdefghijklmnop";
const sf = vi.mocked(steadfast);

export async function sessionUserFor(phone: string): Promise<SessionUser> {
  const user = await prisma.user.findUniqueOrThrow({ where: { phone }, select: { id: true, teamId: true, role: { select: { name: true } } } });
  return { id: user.id, role: user.role.name, teamId: user.teamId };
}

let seq = 0;
export const uniquePhone = () => `019${String(Date.now() % 1e6).padStart(6, "0")}${String(++seq % 100).padStart(2, "0")}`;

export async function setupIntegration(tx: Prisma.TransactionClient, opts: { enabled?: boolean } = {}) {
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

export type PackedOrderOpts = { phone?: string; altPhone?: string | null; lines?: number; qty?: number; deliveryNote?: string | null; internalNote?: string | null; zone?: "INSIDE_CITY" | "OUTSIDE_CITY" };

/** A real PACKED order: reserved at CONFIRMED, then packed through packOrder (SALE_OUT + cost snapshot). */
export async function makePackedOrder(tx: Prisma.TransactionClient, opts: PackedOrderOpts = {}) {
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

export function mockCreateOk(consignmentId: number, trackingCode: string) {
  sf.createOrder.mockImplementationOnce(async (_creds, payload) => ({
    consignment: { consignment_id: consignmentId, invoice: payload.invoice, tracking_code: trackingCode, status: "in_review" },
    raw: { status: 200, message: "Consignment has been created successfully.", consignment: { consignment_id: consignmentId, invoice: payload.invoice, tracking_code: trackingCode, status: "in_review" } },
  }));
}

export async function sendOne(tx: Prisma.TransactionClient, orderId: string, consignmentId = 9_000_001, trackingCode = "TRK9000001") {
  const admin = await sessionUserFor("01711000001");
  mockCreateOk(consignmentId, trackingCode);
  const [result] = await sendOrdersToSteadfast(tx, { orderIds: [orderId] }, admin);
  expect(result.ok, result.error).toBe(true);
  return result;
}

export const webhook = (tx: Prisma.TransactionClient, body: Record<string, unknown>, token: string | null = TOKEN) =>
  handleSteadfastWebhook(tx, token === null ? null : `Bearer ${token}`, body);

export const orderStatus = async (tx: Prisma.TransactionClient, id: string) => (await tx.order.findUniqueOrThrow({ where: { id } })).status;
export const historyCount = (tx: Prisma.TransactionClient, id: string) => tx.orderStatusHistory.count({ where: { orderId: id } });

