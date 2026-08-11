/*
  Warnings:

  - Added the required column `userId` to the `SaleTemp` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "SaleTemp" ADD COLUMN     "userId" INTEGER NOT NULL;
