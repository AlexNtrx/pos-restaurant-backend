-- Remove cart rows that cannot satisfy the new required relations.
DELETE FROM "SaleTempDetail"
WHERE "saleTempId" IN (
  SELECT st."id"
  FROM "SaleTemp" st
  LEFT JOIN "User" u ON u."id" = st."userId"
  WHERE st."foodId" IS NULL OR u."id" IS NULL
);

DELETE FROM "SaleTemp" st
WHERE st."foodId" IS NULL
   OR NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = st."userId");

-- Preserve the oldest line and combine duplicate quantities before adding uniqueness.
CREATE TEMP TABLE "SaleTempMerge" AS
SELECT
  MIN("id") AS "keeperId",
  "userId",
  "tableNo",
  "foodId",
  SUM(GREATEST(COALESCE("qty", 1), 1))::integer AS "desiredQty"
FROM "SaleTemp"
GROUP BY "userId", "tableNo", "foodId";

UPDATE "SaleTempDetail" detail
SET "saleTempId" = merge."keeperId"
FROM "SaleTemp" source
JOIN "SaleTempMerge" merge
  ON merge."userId" = source."userId"
 AND merge."tableNo" = source."tableNo"
 AND merge."foodId" = source."foodId"
WHERE detail."saleTempId" = source."id"
  AND source."id" <> merge."keeperId";

DELETE FROM "SaleTemp" cart
USING "SaleTempMerge" merge
WHERE cart."userId" = merge."userId"
  AND cart."tableNo" = merge."tableNo"
  AND cart."foodId" = merge."foodId"
  AND cart."id" <> merge."keeperId";

UPDATE "SaleTemp" cart
SET "qty" = GREATEST(
  merge."desiredQty",
  (SELECT COUNT(*)::integer FROM "SaleTempDetail" detail WHERE detail."saleTempId" = cart."id")
)
FROM "SaleTempMerge" merge
WHERE cart."id" = merge."keeperId";

INSERT INTO "SaleTempDetail" ("saleTempId", "foodId")
SELECT cart."id", cart."foodId"
FROM "SaleTemp" cart
CROSS JOIN LATERAL generate_series(
  1,
  cart."qty" - (SELECT COUNT(*)::integer FROM "SaleTempDetail" detail WHERE detail."saleTempId" = cart."id")
);

DROP TABLE "SaleTempMerge";

ALTER TABLE "SaleTemp" ALTER COLUMN "foodId" SET NOT NULL;
ALTER TABLE "SaleTemp" ALTER COLUMN "qty" SET DEFAULT 1;
ALTER TABLE "SaleTemp" ALTER COLUMN "qty" SET NOT NULL;

CREATE UNIQUE INDEX "SaleTemp_userId_tableNo_foodId_key"
ON "SaleTemp"("userId", "tableNo", "foodId");

ALTER TABLE "SaleTemp"
ADD CONSTRAINT "SaleTemp_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
