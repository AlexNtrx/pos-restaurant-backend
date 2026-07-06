/*
  Warnings:

  - You are about to drop the column `qty` on the `SaleTempDetail` table. All the data in the column will be lost.
  - Changed the type of `tableNo` on the `SaleTemp` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "SaleTemp" ADD COLUMN     "foodId" INTEGER,
ADD COLUMN     "qty" INTEGER,
DROP COLUMN "tableNo",
ADD COLUMN     "tableNo" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "SaleTempDetail" DROP COLUMN "qty";

-- AddForeignKey
ALTER TABLE "SaleTemp" ADD CONSTRAINT "SaleTemp_foodId_fkey" FOREIGN KEY ("foodId") REFERENCES "Food"("id") ON DELETE SET NULL ON UPDATE CASCADE;
