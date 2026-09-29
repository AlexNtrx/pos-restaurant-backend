-- EN: Existing foods remain valid without a separate image for More info.
-- FI: Nykyiset annokset pysyvät kelvollisina ilman erillistä lisätietokuvaa.
ALTER TABLE "Food" ADD COLUMN "detailImg" TEXT NOT NULL DEFAULT '';
