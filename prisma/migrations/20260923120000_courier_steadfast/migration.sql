-- CreateEnum
CREATE TYPE "CourierProvider" AS ENUM ('STEADFAST');

-- CreateEnum
CREATE TYPE "ShipmentEventSource" AS ENUM ('WEBHOOK', 'POLL', 'API');

-- CreateEnum
CREATE TYPE "ShipmentSubStatus" AS ENUM ('PENDING', 'DELIVERY_APPROVAL_PENDING', 'PARTIAL_DELIVERY_APPROVAL_PENDING', 'RETURN_APPROVAL_PENDING');

-- CreateEnum
CREATE TYPE "ReturnInspectionSource" AS ENUM ('COURIER_RETURN', 'PARTIAL_DELIVERY', 'CUSTOMER_RETURN', 'EXCHANGE');

-- CreateEnum
CREATE TYPE "ReturnInspectionStatus" AS ENUM ('AWAITING_KEPT_ITEMS', 'PENDING', 'COMPLETED');

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'PARTIAL_DELIVERED';

-- AlterTable
ALTER TABLE "courier_companies" ADD COLUMN     "provider" "CourierProvider";

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "returnChargeInspectionId" TEXT;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "returnedQty" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "deliveryNote" TEXT;

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "weightGrams" INTEGER;

-- CreateTable
CREATE TABLE "courier_cost_rates" (
    "id" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "zone" "DeliveryZone" NOT NULL,
    "baseRate" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "perKgRate" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courier_cost_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courier_integrations" (
    "id" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "provider" "CourierProvider" NOT NULL,
    "apiKeyEncrypted" TEXT,
    "secretKeyEncrypted" TEXT,
    "webhookTokenEncrypted" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "pollingMinutes" INTEGER NOT NULL DEFAULT 15,
    "connectedAt" TIMESTAMP(3),
    "lastBalance" DECIMAL(12,2),
    "lastBalanceAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastWebhookAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courier_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "consignmentId" TEXT,
    "trackingCode" TEXT,
    "trackingUrl" TEXT,
    "steadfastStatus" TEXT,
    "subStatus" "ShipmentSubStatus",
    "onHold" BOOLEAN NOT NULL DEFAULT false,
    "needsAttention" BOOLEAN NOT NULL DEFAULT false,
    "attentionReason" TEXT,
    "zone" "DeliveryZone",
    "weightGrams" INTEGER,
    "codAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "courierCostEstimate" DECIMAL(10,2),
    "courierCostActual" DECIMAL(10,2),
    "codCollected" DECIMAL(12,2),
    "codReceivedAt" TIMESTAMP(3),
    "accountsReviewRequired" BOOLEAN NOT NULL DEFAULT false,
    "accountsReviewedAt" TIMESTAMP(3),
    "accountsReviewedById" TEXT,
    "bookedAt" TIMESTAMP(3),
    "bookedById" TEXT,
    "inTransitAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "lastStatusAt" TIMESTAMP(3),
    "lastPolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_status_logs" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT,
    "source" "ShipmentEventSource" NOT NULL,
    "rawStatus" TEXT,
    "rawPayload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_status_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_tracking_events" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "eventAt" TIMESTAMP(3) NOT NULL,
    "source" "ShipmentEventSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_tracking_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_inspections" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shipmentId" TEXT,
    "source" "ReturnInspectionSource" NOT NULL,
    "status" "ReturnInspectionStatus" NOT NULL DEFAULT 'PENDING',
    "keptItemsMarkedAt" TIMESTAMP(3),
    "keptItemsMarkedById" TEXT,
    "inspectedAt" TIMESTAMP(3),
    "inspectedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "return_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_inspection_lines" (
    "id" TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "goodQty" INTEGER NOT NULL DEFAULT 0,
    "damagedQty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "return_inspection_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "courier_cost_rates_courierId_zone_key" ON "courier_cost_rates"("courierId", "zone");

-- CreateIndex
CREATE UNIQUE INDEX "courier_integrations_courierId_key" ON "courier_integrations"("courierId");

-- CreateIndex
CREATE UNIQUE INDEX "courier_integrations_provider_key" ON "courier_integrations"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_orderId_key" ON "shipments"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_consignmentId_key" ON "shipments"("consignmentId");

-- CreateIndex
CREATE INDEX "shipments_courierId_idx" ON "shipments"("courierId");

-- CreateIndex
CREATE INDEX "shipments_finalizedAt_idx" ON "shipments"("finalizedAt");

-- CreateIndex
CREATE INDEX "shipments_needsAttention_idx" ON "shipments"("needsAttention");

-- CreateIndex
CREATE INDEX "shipment_status_logs_shipmentId_receivedAt_idx" ON "shipment_status_logs"("shipmentId", "receivedAt");

-- CreateIndex
CREATE INDEX "shipment_status_logs_receivedAt_idx" ON "shipment_status_logs"("receivedAt");

-- CreateIndex
CREATE INDEX "shipment_tracking_events_shipmentId_eventAt_idx" ON "shipment_tracking_events"("shipmentId", "eventAt");

-- CreateIndex
CREATE INDEX "return_inspections_orderId_idx" ON "return_inspections"("orderId");

-- CreateIndex
CREATE INDEX "return_inspections_status_idx" ON "return_inspections"("status");

-- CreateIndex
CREATE UNIQUE INDEX "return_inspection_lines_inspectionId_orderItemId_key" ON "return_inspection_lines"("inspectionId", "orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "courier_companies_provider_key" ON "courier_companies"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_returnChargeInspectionId_key" ON "expenses"("returnChargeInspectionId");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_returnChargeInspectionId_fkey" FOREIGN KEY ("returnChargeInspectionId") REFERENCES "return_inspections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_cost_rates" ADD CONSTRAINT "courier_cost_rates_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "courier_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_integrations" ADD CONSTRAINT "courier_integrations_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "courier_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "courier_companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_accountsReviewedById_fkey" FOREIGN KEY ("accountsReviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_bookedById_fkey" FOREIGN KEY ("bookedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_status_logs" ADD CONSTRAINT "shipment_status_logs_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_tracking_events" ADD CONSTRAINT "shipment_tracking_events_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_keptItemsMarkedById_fkey" FOREIGN KEY ("keptItemsMarkedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_inspections" ADD CONSTRAINT "return_inspections_inspectedById_fkey" FOREIGN KEY ("inspectedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_inspection_lines" ADD CONSTRAINT "return_inspection_lines_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "return_inspections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_inspection_lines" ADD CONSTRAINT "return_inspection_lines_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

