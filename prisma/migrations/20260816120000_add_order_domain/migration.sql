-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('COUNTER', 'QR');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('SUBMITTED', 'CONFIRMED', 'REJECTED', 'PREPARING', 'READY', 'SERVED', 'PAID', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderModifierType" AS ENUM ('SIZE', 'TASTE');

-- CreateEnum
CREATE TYPE "OrderActorType" AS ENUM ('CUSTOMER', 'STAFF', 'SYSTEM');

-- CreateEnum
CREATE TYPE "TableSessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterTable
ALTER TABLE "BillSale" ADD COLUMN "tableSessionId" INTEGER;

-- CreateTable
CREATE TABLE "RestaurantTable" (
    "id" SERIAL NOT NULL,
    "tableNo" INTEGER NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'use',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantTable_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RestaurantTable_tableNo_positive" CHECK ("tableNo" > 0)
);

-- CreateTable
CREATE TABLE "TableSession" (
    "id" SERIAL NOT NULL,
    "restaurantTableId" INTEGER NOT NULL,
    "status" "TableSessionStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TableSession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TableSession_closed_state" CHECK (
      ("status" = 'OPEN' AND "closedAt" IS NULL)
      OR ("status" = 'CLOSED' AND "closedAt" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "Order" (
    "id" SERIAL NOT NULL,
    "channel" "OrderChannel" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'SUBMITTED',
    "restaurantTableId" INTEGER,
    "tableSessionId" INTEGER,
    "tableNo" INTEGER NOT NULL,
    "createdByUserId" INTEGER,
    "subtotal" INTEGER NOT NULL,
    "modifierTotal" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "idempotencyScope" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "idempotencyFingerprint" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "preparingAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "servedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "cancellationReason" TEXT,
    "billSaleId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Order_tableNo_positive" CHECK ("tableNo" > 0),
    CONSTRAINT "Order_totals_valid" CHECK (
      "subtotal" >= 0
      AND "modifierTotal" >= 0
      AND "total" = "subtotal" + "modifierTotal"
    ),
    CONSTRAINT "Order_version_positive" CHECK ("version" > 0),
    CONSTRAINT "Order_fingerprint_sha256" CHECK (char_length("idempotencyFingerprint") = 64),
    CONSTRAINT "Order_qr_session_required" CHECK ("channel" <> 'QR' OR "tableSessionId" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "foodId" INTEGER NOT NULL,
    "foodName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitBasePrice" INTEGER NOT NULL,
    "unitModifierTotal" INTEGER NOT NULL,
    "unitTotal" INTEGER NOT NULL,
    "lineTotal" INTEGER NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrderItem_amounts_valid" CHECK (
      "quantity" > 0
      AND "unitBasePrice" >= 0
      AND "unitModifierTotal" >= 0
      AND "unitTotal" = "unitBasePrice" + "unitModifierTotal"
      AND "lineTotal" = "unitTotal" * "quantity"
    )
);

-- CreateTable
CREATE TABLE "OrderItemModifier" (
    "id" SERIAL NOT NULL,
    "orderItemId" INTEGER NOT NULL,
    "type" "OrderModifierType" NOT NULL,
    "foodSizeId" INTEGER,
    "tasteId" INTEGER,
    "name" TEXT NOT NULL,
    "priceAdjustment" INTEGER NOT NULL,

    CONSTRAINT "OrderItemModifier_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrderItemModifier_source_valid" CHECK (
      ("type" = 'SIZE' AND "foodSizeId" IS NOT NULL AND "tasteId" IS NULL)
      OR ("type" = 'TASTE' AND "tasteId" IS NOT NULL AND "foodSizeId" IS NULL)
    ),
    CONSTRAINT "OrderItemModifier_price_nonnegative" CHECK ("priceAdjustment" >= 0)
);

-- CreateTable
CREATE TABLE "OrderStatusHistory" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "version" INTEGER NOT NULL,
    "actorType" "OrderActorType" NOT NULL,
    "actorUserId" INTEGER,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderStatusHistory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrderStatusHistory_version_positive" CHECK ("version" > 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantTable_tableNo_key" ON "RestaurantTable"("tableNo");

-- EN: A table can have many historical sessions but only one active session.
-- FI: Pöydällä voi olla useita historiallisia istuntoja, mutta vain yksi aktiivinen istunto.
CREATE UNIQUE INDEX "TableSession_one_open_per_table_key"
ON "TableSession"("restaurantTableId")
WHERE "status" = 'OPEN';

-- CreateIndex
CREATE INDEX "TableSession_restaurantTableId_status_idx" ON "TableSession"("restaurantTableId", "status");
CREATE INDEX "TableSession_status_openedAt_idx" ON "TableSession"("status", "openedAt");
CREATE INDEX "Order_status_updatedAt_idx" ON "Order"("status", "updatedAt");
CREATE INDEX "Order_channel_status_createdAt_idx" ON "Order"("channel", "status", "createdAt");
CREATE INDEX "Order_tableSessionId_status_createdAt_idx" ON "Order"("tableSessionId", "status", "createdAt");
CREATE INDEX "Order_createdByUserId_createdAt_idx" ON "Order"("createdByUserId", "createdAt");
CREATE INDEX "Order_billSaleId_idx" ON "Order"("billSaleId");
CREATE UNIQUE INDEX "Order_idempotencyScope_idempotencyKey_key" ON "Order"("idempotencyScope", "idempotencyKey");
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");
CREATE INDEX "OrderItem_foodId_idx" ON "OrderItem"("foodId");
CREATE INDEX "OrderItemModifier_orderItemId_idx" ON "OrderItemModifier"("orderItemId");
CREATE INDEX "OrderItemModifier_foodSizeId_idx" ON "OrderItemModifier"("foodSizeId");
CREATE INDEX "OrderItemModifier_tasteId_idx" ON "OrderItemModifier"("tasteId");
CREATE INDEX "OrderStatusHistory_orderId_createdAt_idx" ON "OrderStatusHistory"("orderId", "createdAt");
CREATE UNIQUE INDEX "OrderStatusHistory_orderId_version_key" ON "OrderStatusHistory"("orderId", "version");
CREATE UNIQUE INDEX "BillSale_tableSessionId_key" ON "BillSale"("tableSessionId");

-- AddForeignKey
ALTER TABLE "BillSale" ADD CONSTRAINT "BillSale_tableSessionId_fkey" FOREIGN KEY ("tableSessionId") REFERENCES "TableSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_restaurantTableId_fkey" FOREIGN KEY ("restaurantTableId") REFERENCES "RestaurantTable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_restaurantTableId_fkey" FOREIGN KEY ("restaurantTableId") REFERENCES "RestaurantTable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_tableSessionId_fkey" FOREIGN KEY ("tableSessionId") REFERENCES "TableSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_billSaleId_fkey" FOREIGN KEY ("billSaleId") REFERENCES "BillSale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_foodId_fkey" FOREIGN KEY ("foodId") REFERENCES "Food"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItemModifier" ADD CONSTRAINT "OrderItemModifier_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItemModifier" ADD CONSTRAINT "OrderItemModifier_foodSizeId_fkey" FOREIGN KEY ("foodSizeId") REFERENCES "FoodSize"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderItemModifier" ADD CONSTRAINT "OrderItemModifier_tasteId_fkey" FOREIGN KEY ("tasteId") REFERENCES "Taste"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
