-- EN: Add draft storage without activating or backfilling financial tax policy.
-- FI: Lisää luonnostallennus aktivoimatta tai täyttämättä talouden verokäytäntöä jälkikäteen.
ALTER TABLE "Organization"
  ADD COLUMN "taxSettingsDraft" JSONB,
  ADD COLUMN "taxSettingsVersion" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "Organization_taxSettingsVersion_nonnegative" CHECK ("taxSettingsVersion" >= 0);
