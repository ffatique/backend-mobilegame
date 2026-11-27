INSERT INTO "gem_pack_definitions" ("id", "productId", "platform", "gems", "updatedAt")
VALUES
  (gen_random_uuid(), 'com.kumagames.mylittlepier.pack.10g', 'GOOGLE', 10, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'com.kumagames.mylittlepier.pack.60g', 'GOOGLE', 60, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'com.kumagames.mylittlepier.pack.300g', 'GOOGLE', 300, CURRENT_TIMESTAMP)
ON CONFLICT ("platform", "productId") DO UPDATE
SET "gems" = EXCLUDED."gems", "updatedAt" = CURRENT_TIMESTAMP;
