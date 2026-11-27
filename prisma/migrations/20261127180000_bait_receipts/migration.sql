ALTER TABLE bait_operations ADD COLUMN "baitGranted" INTEGER NOT NULL DEFAULT 0;
UPDATE bait_operations SET "baitGranted" = 3 WHERE "transactionId" IS NOT NULL AND kind IN ('ad', 'guest');
