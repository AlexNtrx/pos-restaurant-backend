-- DropForeignKey
ALTER TABLE "SaleTempDetail" DROP CONSTRAINT "SaleTempDetail_foodSizeId_fkey";

-- DropForeignKey
ALTER TABLE "SaleTempDetail" DROP CONSTRAINT "SaleTempDetail_tasteId_fkey";

-- AlterTable
ALTER TABLE "SaleTempDetail" ALTER COLUMN "tasteId" DROP NOT NULL,
ALTER COLUMN "foodSizeId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "SaleTempDetail" ADD CONSTRAINT "SaleTempDetail_tasteId_fkey" FOREIGN KEY ("tasteId") REFERENCES "Taste"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleTempDetail" ADD CONSTRAINT "SaleTempDetail_foodSizeId_fkey" FOREIGN KEY ("foodSizeId") REFERENCES "FoodSize"("id") ON DELETE SET NULL ON UPDATE CASCADE;
