import "server-only";

import { writeAuditLogWith } from "@/lib/audit/log";
import { withTx, type Db } from "@/lib/db/tx";
import { deleteUploadDir, deleteUploadedFile } from "@/lib/uploads/storage";
import { orderTrashBlock, purgeCutoff, purgeDecision } from "@/lib/trash/policy";
import { loadOrderHistory } from "@/lib/trash/service";

// PRD §4.18 — the nightly trash purge (GET /api/cron/trash-purge). Takes
// everything that has sat in the trash for 30 days:
//
//   orders     deleted outright (only history-free orders ever reach the
//              trash — re-checked here); their photos and invoices go too
//   leads      deleted outright (a converted lead can't be trashed)
//   customers  deleted when nothing points to them; archived when orders,
//   products   leads, store credit / sales, stock, purchases or sets still do
//              — the row stays for history but leaves the trash for good
//   order photos deleted from an order 30+ days ago: file and row
//
// Order matters: orders and leads go first, so a customer whose last order
// was purged tonight can go tonight too. A customer/product still pointed to
// by something *in the trash* waits (it may yet be restored). Each record is
// its own transaction with its own audit row (actor "System"); a failure
// is reported and the rest carry on. Files are removed after the commit.

const BATCH = 500;

export type PurgeSummary = {
  cutoff: string;
  orders: { purged: number; kept: number };
  leads: { purged: number; kept: number };
  customers: { purged: number; archived: number; waiting: number };
  products: { purged: number; archived: number; waiting: number };
  orderPhotos: { purged: number };
  /** Hit the batch size — the rest go tomorrow night. */
  more: boolean;
  failures: { kind: string; id: string; error: string }[];
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function purgeTrash(db: Db, now = new Date()): Promise<PurgeSummary> {
  const cutoff = purgeCutoff(now);
  const due = { deletedAt: { not: null, lt: cutoff } };
  const summary: PurgeSummary = {
    cutoff: cutoff.toISOString(),
    orders: { purged: 0, kept: 0 },
    leads: { purged: 0, kept: 0 },
    customers: { purged: 0, archived: 0, waiting: 0 },
    products: { purged: 0, archived: 0, waiting: 0 },
    orderPhotos: { purged: 0 },
    more: false,
    failures: [],
  };
  const fail = (kind: string, id: string, e: unknown) => summary.failures.push({ kind, id, error: message(e) });

  // ── Orders ──
  const orders = await db.order.findMany({ where: due, select: { id: true }, orderBy: { deletedAt: "asc" }, take: BATCH });
  summary.more ||= orders.length === BATCH;
  for (const { id } of orders) {
    try {
      const orderNo = await withTx(db, async (tx) => {
        const order = await tx.order.findFirst({ where: { id, ...due }, include: { _count: { select: { items: true, images: true, invoices: true } } } });
        if (!order) return null;
        const history = await loadOrderHistory(tx, id);
        const block = history ? orderTrashBlock(history) : null;
        if (block) {
          summary.orders.kept++;
          fail("order", id, `Kept: ${block}`);
          return null;
        }
        await tx.order.delete({ where: { id } });
        await writeAuditLogWith(tx, {
          actorId: null,
          action: "order.purge",
          entityType: "order",
          entityId: id,
          before: { orderNo: order.orderNo, status: order.status, customerId: order.customerId, total: order.total.toString(), deletedAt: order.deletedAt, items: order._count.items, photos: order._count.images, invoices: order._count.invoices },
          after: null,
        });
        return order.orderNo;
      });
      if (orderNo) {
        summary.orders.purged++;
        await deleteUploadDir(`orders/${orderNo}`).catch((e) => fail("order-files", id, e));
      }
    } catch (e) {
      fail("order", id, e);
    }
  }

  // ── Leads ──
  const leads = await db.lead.findMany({ where: due, select: { id: true }, orderBy: { deletedAt: "asc" }, take: BATCH });
  summary.more ||= leads.length === BATCH;
  for (const { id } of leads) {
    try {
      await withTx(db, async (tx) => {
        const lead = await tx.lead.findFirst({ where: { id, ...due }, include: { order: { select: { id: true } }, _count: { select: { followUps: true } } } });
        if (!lead) return;
        if (lead.order) {
          summary.leads.kept++;
          return;
        }
        await tx.lead.delete({ where: { id } });
        await writeAuditLogWith(tx, {
          actorId: null,
          action: "lead.purge",
          entityType: "lead",
          entityId: id,
          before: { name: lead.name, phone: lead.phone, status: lead.status, source: lead.source, deletedAt: lead.deletedAt, followUps: lead._count.followUps },
          after: null,
        });
        summary.leads.purged++;
      });
    } catch (e) {
      fail("lead", id, e);
    }
  }

  // ── Customers ──
  const customers = await db.customer.findMany({ where: { ...due, archivedAt: null }, select: { id: true }, orderBy: { deletedAt: "asc" }, take: BATCH });
  summary.more ||= customers.length === BATCH;
  for (const { id } of customers) {
    try {
      await withTx(db, async (tx) => {
        const customer = await tx.customer.findFirst({ where: { id, ...due, archivedAt: null } });
        if (!customer) return;
        const [liveOrders, trashedOrders, liveLeads, trashedLeads, credit] = await Promise.all([
          tx.order.count({ where: { customerId: id, deletedAt: null } }),
          tx.order.count({ where: { customerId: id, deletedAt: { not: null } } }),
          tx.lead.count({ where: { customerId: id, deletedAt: null } }),
          tx.lead.count({ where: { customerId: id, deletedAt: { not: null } } }),
          tx.storeCreditEntry.count({ where: { customerId: id } }),
        ]);
        const decision = purgeDecision(liveOrders + liveLeads + credit, trashedOrders + trashedLeads);
        const before = { name: customer.name, phone: customer.phone, deletedAt: customer.deletedAt, orders: liveOrders + trashedOrders, leads: liveLeads + trashedLeads, storeCreditEntries: credit };
        if (decision === "defer") {
          summary.customers.waiting++;
        } else if (decision === "archive") {
          const archivedAt = new Date();
          await tx.customer.update({ where: { id }, data: { archivedAt } });
          await writeAuditLogWith(tx, { actorId: null, action: "customer.archive", entityType: "customer", entityId: id, before, after: { archivedAt } });
          summary.customers.archived++;
        } else {
          await tx.customer.delete({ where: { id } });
          await writeAuditLogWith(tx, { actorId: null, action: "customer.purge", entityType: "customer", entityId: id, before, after: null });
          summary.customers.purged++;
        }
      });
    } catch (e) {
      fail("customer", id, e);
    }
  }

  // ── Products ──
  const products = await db.product.findMany({ where: { ...due, archivedAt: null }, select: { id: true }, orderBy: { deletedAt: "asc" }, take: BATCH });
  summary.more ||= products.length === BATCH;
  for (const { id } of products) {
    try {
      const deleted = await withTx(db, async (tx) => {
        const product = await tx.product.findFirst({ where: { id, ...due, archivedAt: null }, include: { _count: { select: { variants: true, images: true } } } });
        if (!product) return false;
        const variant = { variant: { productId: id } };
        const [liveSales, trashedSales, movements, purchases, packagingUses, exchangeLines, setComponents, stockDocLines] = await Promise.all([
          tx.orderItem.count({ where: { ...variant, order: { deletedAt: null } } }),
          tx.orderItem.count({ where: { ...variant, order: { deletedAt: { not: null } } } }),
          tx.stockMovement.count({ where: variant }),
          tx.purchaseItem.count({ where: variant }),
          tx.packagingComponent.count({ where: { materialVariant: { productId: id } } }),
          tx.returnCaseLine.count({ where: { replacementVariant: { productId: id } } }),
          tx.outfitSetComponent.count({ where: { productId: id } }),
          // C4 — a transfer or stock count that names it (even a draft never sent) keeps its record.
          Promise.all([tx.stockTransferLine.count({ where: variant }), tx.stockCountLine.count({ where: variant })]).then(([a, b]) => a + b),
        ]);
        const decision = purgeDecision(liveSales + movements + purchases + packagingUses + exchangeLines + setComponents + stockDocLines, trashedSales);
        const before = { code: product.code, name: product.name, deletedAt: product.deletedAt, variants: product._count.variants, images: product._count.images, sales: liveSales + trashedSales, stockMovements: movements, purchases, setComponents };
        if (decision === "defer") {
          summary.products.waiting++;
          return false;
        }
        if (decision === "archive") {
          const archivedAt = new Date();
          await tx.product.update({ where: { id }, data: { archivedAt } });
          await writeAuditLogWith(tx, { actorId: null, action: "catalog.product.archive", entityType: "product", entityId: id, before, after: { archivedAt } });
          summary.products.archived++;
          return false;
        }
        // Variants, photos and the product's own packaging list go with it (cascade).
        await tx.product.delete({ where: { id } });
        await writeAuditLogWith(tx, { actorId: null, action: "catalog.product.purge", entityType: "product", entityId: id, before, after: null });
        summary.products.purged++;
        return true;
      });
      if (deleted) await deleteUploadDir(`products/${id}`).catch((e) => fail("product-files", id, e));
    } catch (e) {
      fail("product", id, e);
    }
  }

  // ── Photos deleted from live orders ──
  const photos = await db.orderImage.findMany({ where: due, select: { id: true, orderId: true, filePath: true, thumbPath: true, deletedAt: true }, orderBy: { deletedAt: "asc" }, take: BATCH });
  summary.more ||= photos.length === BATCH;
  for (const photo of photos) {
    try {
      await withTx(db, async (tx) => {
        await tx.orderImage.delete({ where: { id: photo.id } });
        await writeAuditLogWith(tx, { actorId: null, action: "order.image.purge", entityType: "order", entityId: photo.orderId, before: { imageId: photo.id, filePath: photo.filePath, deletedAt: photo.deletedAt }, after: null });
      });
      summary.orderPhotos.purged++;
      await Promise.all([deleteUploadedFile(photo.filePath), deleteUploadedFile(photo.thumbPath)]).catch((e) => fail("photo-files", photo.id, e));
    } catch (e) {
      fail("photo", photo.id, e);
    }
  }

  return summary;
}
