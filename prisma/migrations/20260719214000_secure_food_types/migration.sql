-- Category names may be reused after soft deletion, but active categories must be unambiguous.
CREATE UNIQUE INDEX "FoodType_active_name_key"
ON "FoodType"("name")
WHERE "status" = 'use';
