-- The application has one organization profile used by receipts.
CREATE UNIQUE INDEX "Organization_singleton_key"
ON "Organization" ((true));
