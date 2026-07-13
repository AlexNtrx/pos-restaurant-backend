/*
  Warnings:

  - Added the required column `payType` to the `BillSale` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "BillSale" ADD COLUMN     "payType" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "BillSaleDetail" ADD COLUMN     "moneyAdded" INTEGER;
