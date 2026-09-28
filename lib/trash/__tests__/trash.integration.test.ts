import type { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// Route handlers call auth(); next-auth can't load under plain Node, so the
// session is whatever the test says it is.
const session = vi.hoisted(() => ({ current: null as null | { user: { id: string; role: string; teamId: string | null } } }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => session.current) }));

import { POST as backupReport } from "@/app/api/cron/backup-report/route";
import { GET as lowStockCron } from "@/app/api/cron/low-stock-alert/route";
import { GET as purgeCron } from "@/app/api/cron/trash-purge/route";
import { GET as notificationsRoute } from "@/app/api/notifications/route";
import { DELETE as deleteOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as restoreOrderRoute } from "@/app/api/orders/[id]/restore/route";
import { GET as trashRoute } from "@/app/api/trash/route";
import type { SessionUser } from "@/lib/auth/types";
import { recordStockMovement } from "@/lib/inventory/ledger";
import { lowStockAlertText, sendLowStockAlert } from "@/lib/inventory/low-stock-alert";
import type { LowStockProductAlert } from "@/lib/inventory/types";
import { SEEDED_LOCATION_IDS } from "@/lib/locations/constants";
import { listNotifications, markNotificationsRead } from "@/lib/notifications/queries";
import { resolveCounterCustomer } from "@/lib/pos/sale";
import { prisma } from "@/lib/prisma";
import { getBackupHealth, recordJobRun } from "@/lib/system/jobs";
import { testProductCode, testSku } from "@/lib/test/catalog-codes";
import { freshPhone, PHONES, userFor } from "@/lib/test/returns-fixtures";
import { inRolledBackTransaction } from "@/lib/test/rollback";
import { purgeTrash } from "@/lib/trash/purge";
import { listTrash } from "@/lib/trash/queries";
import { restoreOrder, TrashError, trashOrder } from "@/lib/trash/service";

// P5.1 (PRD §4.18) — the trash, the nightly purge, the low-stock alert and
// the backup report. Everything that writes runs in a rolled-back
// transaction; the route calls below only reach their auth and validation.

const DAY = 86_400_000;
const daysAgo = (d: number, now = new Date()) => new Date(now.getTime() - d * DAY);
const cuid = "ckzzzzzzzzzzzzzzzzzzzzzzz";

async function signInAs(phone: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { phone }, select: { id: true, teamId: true, role: { select: { name: true } } } });
  session.current = { user: { id: u.id, role: u.role.name, teamId: u.teamId } };
}
afterEach(() => {
  session.current = null;
});

const req = (url: string, init?: { method?: string; body?: unknown; bearer?: string }) =>
  new NextRequest(`http://localhost${url}`, {
    method: init?.method ?? "GET",
    headers: { ...(init?.bearer ? { authorization: `Bearer ${init.bearer}` } : {}), "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

let orderSeq = 0;
async function order(tx: Prisma.TransactionClient, by: SessionUser, opts: { status?: "LEAD" | "CONFIRMED" | "CANCELLED"; customerId?: string } = {}) {
  const customerId = opts.customerId ?? (await tx.customer.create({ data: { name: "Trash Test Customer", phone: freshPhone(), createdById: by.id, teamId: by.teamId } })).id;
  return tx.order.create({
    data: { orderNo: `TEST-TR-${Date.now()}-${++orderSeq}`, status: opts.status ?? "LEAD", customerId, createdById: by.id, teamId: by.teamId },
  });
}

async function product(tx: Prisma.TransactionClient, opts: { stocked?: boolean } = {}) {
  const [size, color] = await Promise.all([tx.size.findFirstOrThrow(), tx.color.findFirstOrThrow()]);
  const code = testProductCode();
  const p = await tx.product.create({ data: { code, name: `Trash test ${code}`, basePrice: 1200 } });
  const v = await tx.productVariant.create({ data: { productId: p.id, sizeId: size.id, colorId: color.id, sku: testSku(code) } });
  if (opts.stocked) await recordStockMovement(tx, { variantId: v.id, locationId: SEEDED_LOCATION_IDS.mohammadpur, type: "PURCHASE_IN", qty: 3, unitCost: 500, referenceType: "OPENING_BALANCE", actorId: null });
  return p;
}

describe("who can reach the trash routes", () => {
  it("refuses the cron routes without CRON_SECRET", async () => {
    for (const handler of [purgeCron, lowStockCron]) {
      expect((await handler(req("/api/cron/x"))).status).toBe(401);
      expect((await handler(req("/api/cron/x", { bearer: "wrong" }))).status).toBe(401);
    }
    expect((await backupReport(req("/api/cron/backup-report", { method: "POST", body: { ok: true } }))).status).toBe(401);
  });

  it("validates a backup report before recording it", async () => {
    const bearer = process.env.CRON_SECRET!;
    const at = new Date().toISOString();
    const bad = [
      { ok: true, startedAt: at, finishedAt: at }, // no dump file
      { ok: false, startedAt: at, finishedAt: at }, // no reason
      { ok: true, startedAt: at, finishedAt: at, file: "../../etc/passwd", sizeBytes: 10 },
      { ok: true, startedAt: at, finishedAt: new Date(Date.now() + DAY).toISOString(), file: "a.dump", sizeBytes: 10 },
      "not json",
    ];
    for (const body of bad) expect((await backupReport(req("/api/cron/backup-report", { method: "POST", body, bearer }))).status).toBe(400);
  });

  it("keeps executives and packing out of deleting orders and out of the trash", async () => {
    for (const phone of [PHONES.SE, PHONES.TL, PHONES.PACKING, PHONES.POS]) {
      await signInAs(phone);
      expect((await deleteOrderRoute(req(`/api/orders/${cuid}`, { method: "DELETE" }), params(cuid))).status).toBe(403);
      expect((await restoreOrderRoute(req(`/api/orders/${cuid}/restore`, { method: "POST" }), params(cuid))).status).toBe(403);
    }
    for (const phone of [PHONES.SE, PHONES.PACKING, PHONES.ACCOUNTS, PHONES.POS]) {
      await signInAs(phone);
      expect((await trashRoute(req("/api/trash"))).status).toBe(403);
    }
  });

  it("shows an admin every kind, and 404s an order that isn't there", async () => {
    await signInAs(PHONES.ADMIN);
    const res = await trashRoute(req("/api/trash?kind=customer"));
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()).counts).sort()).toEqual(["customer", "lead", "order", "product"]);
    expect((await deleteOrderRoute(req(`/api/orders/${cuid}`, { method: "DELETE" }), params(cuid))).status).toBe(404);
  });

  it("needs a session for notifications", async () => {
    expect((await notificationsRoute()).status).toBe(401);
  });
});

describe("moving an order to the trash and back", () => {
  it("trashes a never-confirmed order, logs it, and restores it", () =>
    inRolledBackTransaction(async (tx) => {
      const [admin, se] = await Promise.all([userFor(tx, PHONES.ADMIN), userFor(tx, PHONES.SE)]);
      const o = await order(tx, se);
      await trashOrder(tx, admin, o.id);
      expect((await tx.order.findUniqueOrThrow({ where: { id: o.id } })).deletedAt).not.toBeNull();
      expect(await tx.auditLog.count({ where: { action: "order.trash", entityId: o.id, actorId: admin.id } })).toBe(1);

      const page = await listTrash(tx, admin, ["order"], { kind: "order", q: o.orderNo, page: 1 });
      expect(page?.items.map((i) => i.id)).toEqual([o.id]);
      expect(page?.items[0]).toMatchObject({ daysLeft: 30, deletedBy: expect.any(String) });

      await restoreOrder(tx, admin, o.id);
      expect((await tx.order.findUniqueOrThrow({ where: { id: o.id } })).deletedAt).toBeNull();
      expect(await tx.auditLog.count({ where: { action: "order.restore", entityId: o.id } })).toBe(1);
    }));

  it("refuses an order with history: confirmed, or cancelled after money came in", () =>
    inRolledBackTransaction(async (tx) => {
      const [admin, se] = await Promise.all([userFor(tx, PHONES.ADMIN), userFor(tx, PHONES.SE)]);
      const confirmed = await order(tx, se, { status: "CONFIRMED" });
      await expect(trashOrder(tx, admin, confirmed.id)).rejects.toMatchObject({ status: 409 });

      const cancelled = await order(tx, se, { status: "CANCELLED" });
      const wallet = await tx.wallet.findFirstOrThrow({ where: { isActive: true } });
      await tx.payment.create({ data: { orderId: cancelled.id, amount: 500, method: "CASH", walletId: wallet.id, receivedById: se.id } });
      const err = await trashOrder(tx, admin, cancelled.id).catch((e) => e);
      expect(err).toBeInstanceOf(TrashError);
      expect(err.message).toMatch(/Money/);
      expect((await tx.order.findUniqueOrThrow({ where: { id: cancelled.id } })).deletedAt).toBeNull();
    }));

  it("brings the customer back when their order is restored", () =>
    inRolledBackTransaction(async (tx) => {
      const [admin, se] = await Promise.all([userFor(tx, PHONES.ADMIN), userFor(tx, PHONES.SE)]);
      const o = await order(tx, se);
      await trashOrder(tx, admin, o.id);
      await tx.customer.update({ where: { id: o.customerId! }, data: { deletedAt: new Date() } });
      await restoreOrder(tx, admin, o.id);
      expect((await tx.customer.findUniqueOrThrow({ where: { id: o.customerId! } })).deletedAt).toBeNull();
    }));

  it("scopes the trash like the lists: an executive sees only their own (CLAUDE.md rule 6)", () =>
    inRolledBackTransaction(async (tx) => {
      const [admin, se, rima] = await Promise.all([userFor(tx, PHONES.ADMIN), userFor(tx, PHONES.SE), userFor(tx, "01711000008")]);
      const mine = await order(tx, se);
      const theirs = await order(tx, rima);
      await trashOrder(tx, admin, mine.id);
      await trashOrder(tx, admin, theirs.id);
      // As if order.delete had been granted to the executive by override.
      const seen = (await listTrash(tx, se, ["order"], { kind: "order", page: 1 }))!.items.map((i) => i.id);
      expect(seen).toContain(mine.id);
      expect(seen).not.toContain(theirs.id);
      await expect(restoreOrder(tx, se, theirs.id)).rejects.toMatchObject({ status: 404 });
      const custSeen = (await listTrash(tx, se, ["customer"], { kind: "customer", page: 1 }))!.items;
      expect(custSeen.every((c) => c.id !== theirs.customerId)).toBe(true);
    }));
});

describe("the nightly purge", () => {
  it("deletes what has no history, archives what does, and waits on what's still in the trash", () =>
    inRolledBackTransaction(async (tx) => {
      const [se, pos] = await Promise.all([userFor(tx, PHONES.SE), userFor(tx, PHONES.POS)]);
      const now = new Date();
      const old = daysAgo(31, now);
      const recent = daysAgo(5, now);

      // A lead order and its customer, both trashed a month ago → both go.
      const gone = await order(tx, se);
      await tx.order.update({ where: { id: gone.id }, data: { deletedAt: old } });
      await tx.customer.update({ where: { id: gone.customerId! }, data: { deletedAt: old } });
      await tx.orderImage.create({ data: { orderId: gone.id, filePath: `orders/${gone.orderNo}/a.jpg`, thumbPath: `orders/${gone.orderNo}/a_thumb.jpg`, mimeType: "image/jpeg", sizeBytes: 10 } });
      // A customer with a live order → archived, not deleted.
      const kept = await order(tx, se, { status: "CONFIRMED" });
      await tx.customer.update({ where: { id: kept.customerId! }, data: { deletedAt: old } });
      // A customer whose only order was trashed last week → waits for it.
      const waiting = await order(tx, se);
      await tx.order.update({ where: { id: waiting.id }, data: { deletedAt: recent } });
      await tx.customer.update({ where: { id: waiting.customerId! }, data: { deletedAt: old } });
      // A never-stocked product → deleted; a stocked one → archived; one trashed last week → untouched.
      const [bare, stocked, fresh] = await Promise.all([product(tx), product(tx, { stocked: true }), product(tx)]);
      await tx.product.update({ where: { id: bare.id }, data: { deletedAt: old } });
      await tx.product.update({ where: { id: stocked.id }, data: { deletedAt: old } });
      await tx.product.update({ where: { id: fresh.id }, data: { deletedAt: recent } });
      // A lost lead → deleted.
      const lead = await tx.lead.create({ data: { name: "Trash test lead", source: "MESSENGER", createdById: se.id, teamId: se.teamId, deletedAt: old } });
      // A photo deleted from a live order a month ago → file and row go.
      const photo = await tx.orderImage.create({ data: { orderId: kept.id, filePath: `orders/${kept.orderNo}/b.jpg`, thumbPath: `orders/${kept.orderNo}/b_thumb.jpg`, mimeType: "image/jpeg", sizeBytes: 10, deletedAt: old } });

      const summary = await purgeTrash(tx, now);

      expect(await tx.order.findUnique({ where: { id: gone.id } })).toBeNull();
      expect(await tx.customer.findUnique({ where: { id: gone.customerId! } })).toBeNull();
      expect(await tx.auditLog.count({ where: { action: "order.purge", entityId: gone.id, actorId: null } })).toBe(1);
      expect(await tx.auditLog.count({ where: { action: "customer.purge", entityId: gone.customerId! } })).toBe(1);

      const archived = await tx.customer.findUniqueOrThrow({ where: { id: kept.customerId! } });
      expect(archived.archivedAt).not.toBeNull();
      expect(await tx.order.findUnique({ where: { id: kept.id } })).not.toBeNull();
      expect(await tx.auditLog.count({ where: { action: "customer.archive", entityId: kept.customerId! } })).toBe(1);

      const w = await tx.customer.findUniqueOrThrow({ where: { id: waiting.customerId! } });
      expect(w.archivedAt).toBeNull();
      expect(w.deletedAt).not.toBeNull();
      expect(await tx.order.findUnique({ where: { id: waiting.id } })).not.toBeNull();

      expect(await tx.product.findUnique({ where: { id: bare.id } })).toBeNull();
      expect(await tx.productVariant.count({ where: { productId: bare.id } })).toBe(0);
      expect((await tx.product.findUniqueOrThrow({ where: { id: stocked.id } })).archivedAt).not.toBeNull();
      expect(await tx.stockMovement.count({ where: { variant: { productId: stocked.id } } })).toBe(1);
      expect((await tx.product.findUniqueOrThrow({ where: { id: fresh.id } })).archivedAt).toBeNull();

      expect(await tx.lead.findUnique({ where: { id: lead.id } })).toBeNull();
      expect(await tx.orderImage.findUnique({ where: { id: photo.id } })).toBeNull();
      expect(summary.failures.filter((f) => [gone.id, kept.id, bare.id, stocked.id, lead.id, photo.id].includes(f.id))).toEqual([]);

      // Archived rows have left the trash for good.
      const admin = await userFor(tx, PHONES.ADMIN);
      const trashed = (await listTrash(tx, admin, ["customer"], { kind: "customer", q: archived.phone, page: 1 }))!;
      expect(trashed.items).toEqual([]);

      // Running it again changes nothing for these.
      await purgeTrash(tx, now);
      expect(await tx.auditLog.count({ where: { action: "customer.archive", entityId: kept.customerId! } })).toBe(1);

      // An archived customer who comes back to the counter is revived, not duplicated.
      const back = await resolveCounterCustomer(tx, { user: pos, canCreateCustomer: true }, { phone: archived.phone });
      expect(back?.id).toBe(archived.id);
      expect(await tx.customer.findUniqueOrThrow({ where: { id: archived.id } })).toMatchObject({ deletedAt: null, archivedAt: null });
      expect(await tx.auditLog.count({ where: { action: "customer.restore", entityId: archived.id } })).toBe(1);
    }));
});

describe("the daily low-stock alert", () => {
  const alert: LowStockProductAlert = {
    productId: "p1",
    productName: "Kurti #12",
    productCode: "K12",
    categoryName: null,
    totalVariants: 3,
    lowVariants: [],
    outCount: 2,
    lowCount: 0,
    message: "Only XL left",
  };

  it("summarises the low-stock screen, most urgent first", () => {
    const text = lowStockAlertText([alert, { ...alert, productName: "Saree", productCode: "S1", outCount: 0, lowCount: 1, message: "Only 2 left" }]);
    expect(text.title).toBe("Low stock: 2 products need restocking — 2 variants out of stock, 1 running low");
    expect(text.body).toBe("Kurti #12 (K12): Only XL left\nSaree (S1): Only 2 left");
  });

  it("goes once a day to everyone who buys stock, and to nobody else", () =>
    inRolledBackTransaction(async (tx) => {
      const [admin, manager, se, packing] = await Promise.all([PHONES.ADMIN, PHONES.MANAGER, PHONES.SE, PHONES.PACKING].map((p) => userFor(tx, p)));
      const day = "2099-01-01";
      const first = await sendLowStockAlert(tx, [alert], day);
      expect(first.sent).toBe(first.recipients);
      const got = async (u: SessionUser) => (await listNotifications(tx, u.id)).items.some((n) => n.title.startsWith("Low stock") && n.href === "/inventory/low-stock");
      expect(await got(admin)).toBe(true);
      expect(await got(manager)).toBe(true);
      expect(await got(se)).toBe(false);
      expect(await got(packing)).toBe(false);

      expect((await sendLowStockAlert(tx, [alert], day)).sent).toBe(0);
      expect((await sendLowStockAlert(tx, [], "2099-01-02")).sent).toBe(0);

      // Only your own notifications can be marked read.
      const mine = (await listNotifications(tx, admin.id)).items[0];
      expect(await markNotificationsRead(tx, se.id, { ids: [mine.id] })).toBe(0);
      expect(await markNotificationsRead(tx, admin.id, { ids: [mine.id] })).toBe(1);
    }));
});

describe("backup status", () => {
  it("is stale 48 hours after the last good backup, whatever failed since", () =>
    inRolledBackTransaction(async (tx) => {
      const at = new Date("2099-06-01T00:00:00Z");
      await recordJobRun(tx, { job: "backup", ok: true, startedAt: at, finishedAt: at, summary: { file: "antu-db.dump", sizeBytes: 1000 } });
      expect((await getBackupHealth(tx, new Date(at.getTime() + 47 * 3_600_000))).state).toBe("ok");
      const later = new Date(at.getTime() + 30 * 3_600_000);
      await recordJobRun(tx, { job: "backup", ok: false, startedAt: later, finishedAt: later, error: "pg_dump: server version mismatch" });
      const health = await getBackupHealth(tx, new Date(at.getTime() + 49 * 3_600_000));
      expect(health.state).toBe("stale");
      expect(health.lastFailure?.error).toMatch(/mismatch/);
    }));
});
