/*
  Warnings:

  - Made the column `tableNo` on table `SaleTemp` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "SaleTemp" ALTER COLUMN "tableNo" SET NOT NULL;

-- AlterTable
ALTER TABLE "SaleTempDetail" ADD COLUMN     "qty" INTEGER NOT NULL DEFAULT 1;
