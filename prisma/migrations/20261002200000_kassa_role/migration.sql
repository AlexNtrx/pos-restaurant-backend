BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- EN: Rename the persisted role without replacing users or their financial/history references.
-- FI: Nimeä tallennettu rooli uudelleen korvaamatta käyttäjiä tai heidän maksu- ja historiaviitteitään.
UPDATE "User" SET "level" = 'kassa' WHERE "level" = 'user';
COMMIT;
