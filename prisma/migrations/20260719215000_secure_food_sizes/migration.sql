-- A size label may be reused after soft deletion, but must be unique within an active category.
CREATE UNIQUE INDEX "FoodSize_active_foodTypeId_name_key"
ON "FoodSize"("foodTypeId", "name")
WHERE "status" = 'use';
