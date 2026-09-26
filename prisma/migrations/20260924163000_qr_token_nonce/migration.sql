-- EN: A random nonce plus a server secret regenerates the same token without storing the token itself.
-- FI: Satunnainen nonce ja palvelimen salaisuus palauttavat saman tunnisteen tallentamatta tunnistetta.
ALTER TABLE "TableSession" ADD COLUMN "qrTokenNonce" TEXT;

ALTER TABLE "TableSession" ADD CONSTRAINT "TableSession_qr_nonce_state" CHECK (
    ("qrTokenHash" IS NULL AND "qrTokenNonce" IS NULL)
    OR ("qrTokenHash" IS NOT NULL AND "qrTokenNonce" IS NOT NULL)
);
