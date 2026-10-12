-- EN: Existing bills stay unknown; never backfill current seller data as historical identity.
-- FI: Vanhojen laskujen tiedot jäävät tuntemattomiksi; älä täytä nykyisiä myyjätietoja historialliseksi identiteetiksi.
ALTER TABLE "BillSale" ADD COLUMN "receiptSnapshot" JSONB;
