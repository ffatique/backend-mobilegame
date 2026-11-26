-- CreateEnum
CREATE TYPE "IapPlatform" AS ENUM ('APPLE', 'GOOGLE');

-- CreateEnum
CREATE TYPE "IapEnvironment" AS ENUM ('PRODUCTION', 'SANDBOX');

-- CreateEnum
CREATE TYPE "IapPurchaseStatus" AS ENUM ('GRANTED', 'REFUNDED');

-- AlterTable
ALTER TABLE "players" ADD COLUMN     "gems" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ad_reward_grants" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "transactionId" VARCHAR(64) NOT NULL,
    "adUnit" VARCHAR(64),
    "adNetwork" VARCHAR(64),
    "rewardItem" VARCHAR(32),
    "rewardAmount" INTEGER NOT NULL,
    "coinsGranted" INTEGER NOT NULL,
    "rewardedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_reward_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gem_pack_definitions" (
    "id" UUID NOT NULL,
    "productId" VARCHAR(128) NOT NULL,
    "platform" "IapPlatform" NOT NULL,
    "gems" INTEGER NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gem_pack_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "iap_purchases" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "platform" "IapPlatform" NOT NULL,
    "environment" "IapEnvironment",
    "productId" VARCHAR(128),
    "storeTransactionId" TEXT NOT NULL,
    "orderId" VARCHAR(128),
    "gemsGranted" INTEGER NOT NULL,
    "status" "IapPurchaseStatus" NOT NULL DEFAULT 'GRANTED',
    "purchasedAt" TIMESTAMP(3),
    "lastAdjustmentAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "iap_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ad_reward_grants_transactionId_key" ON "ad_reward_grants"("transactionId");

-- CreateIndex
CREATE INDEX "ad_reward_grants_userId_idx" ON "ad_reward_grants"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "gem_pack_definitions_platform_productId_key" ON "gem_pack_definitions"("platform", "productId");

-- CreateIndex
CREATE INDEX "iap_purchases_userId_createdAt_idx" ON "iap_purchases"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "iap_purchases_platform_storeTransactionId_key" ON "iap_purchases"("platform", "storeTransactionId");

-- AddForeignKey
ALTER TABLE "ad_reward_grants" ADD CONSTRAINT "ad_reward_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iap_purchases" ADD CONSTRAINT "iap_purchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
