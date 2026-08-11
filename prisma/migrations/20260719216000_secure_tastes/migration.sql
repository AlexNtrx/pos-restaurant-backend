-- A taste label may be reused after soft deletion, but must be unique within an active category.
CREATE UNIQUE INDEX "Taste_active_foodTypeId_name_key"
ON "Taste"("foodTypeId", "name")
WHERE "status" = 'use';
