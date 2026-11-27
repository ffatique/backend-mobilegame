import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  JWSTransactionDecodedPayload,
  NotificationTypeV2,
  Type as AppleProductType,
} from '@apple/app-store-server-library';
import {
  GemPackDefinition,
  IapEnvironment,
  IapPlatform,
  IapPurchaseStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppleStoreClient } from './apple/apple-store.client';
import type { PubSubPushDto, VerifyPurchaseResponse, VerifyStatus } from './dto/iap.dto';
import { GooglePlayClient, GoogleProductPurchase } from './google/google-play.client';
import { PubSubPushVerifier } from './google/pubsub-push.verifier';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Google Play ProductPurchase.purchaseState / RTDN enum values.
const GOOGLE_PURCHASED = 0;
const GOOGLE_CANCELED = 1;
const GOOGLE_PENDING = 2;
const GOOGLE_TEST_PURCHASE = 0;
const GOOGLE_NOT_CONSUMED = 0;
const RTDN_ONE_TIME_PURCHASED = 1;
const RTDN_PRODUCT_TYPE_ONE_TIME = 2;

export type NotificationOutcome = 'granted' | 'duplicate' | 'refunded' | 'reversed' | 'ignored';

interface PurchaseRecord {
  platform: IapPlatform;
  environment: IapEnvironment;
  productId: string;
  storeTransactionId: string;
  orderId: string | null;
  purchasedAt: Date;
  rawPayload: Prisma.InputJsonValue;
}

type PurchaseKey = Pick<PurchaseRecord, 'platform' | 'storeTransactionId'>;

interface GrantResult {
  status: 'granted' | 'duplicate' | 'refunded';
  gemsGranted: number;
}

interface RtdnPayload {
  packageName?: string;
  testNotification?: unknown;
  oneTimeProductNotification?: { notificationType?: number; purchaseToken?: string; sku?: string };
  voidedPurchaseNotification?: { purchaseToken?: string; orderId?: string; productType?: number };
}

/**
 * Gem-pack in-app purchases for the App Store and Google Play. Gems are only
 * credited from store-verified data, exactly once per store transaction
 * (unique `(platform, storeTransactionId)`), and refunds take back the
 * `gemsGranted` recorded at purchase time — even if the balance goes negative.
 */
@Injectable()
export class IapService {
  private readonly logger = new Logger(IapService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly apple: AppleStoreClient,
    private readonly google: GooglePlayClient,
    private readonly pubsub: PubSubPushVerifier,
    private readonly config: ConfigService,
  ) {}

  /** Sandbox/TestFlight purchases only credit gems when `IAP_CREDIT_SANDBOX` is
   *  true. Off by default so pre-launch test purchases never grant real value. */
  private gemsFor(pack: GemPackDefinition, environment: IapEnvironment): number {
    const credit = this.config.get<boolean>('IAP_CREDIT_SANDBOX') === true;
    return environment === IapEnvironment.SANDBOX && !credit ? 0 : pack.gems;
  }

  async googleCatalog() {
    return {
      items: await this.prisma.gemPackDefinition.findMany({
        where: { platform: 'GOOGLE', isEnabled: true, gems: { gt: 0 } },
        select: { productId: true, gems: true },
        orderBy: { gems: 'asc' },
      }),
    };
  }

  async verifyApple(userId: string, transactionId: string): Promise<VerifyPurchaseResponse> {
    const { transaction, environment } = await this.apple.getVerifiedTransaction(transactionId);
    if (!sameId(transaction.appAccountToken, userId)) {
      throw new ForbiddenException('Purchase belongs to another account');
    }
    const record = this.appleRecord(transaction, environment);

    if (transaction.revocationDate) {
      await this.refundPurchase(record, userId, new Date(transaction.revocationDate));
      return this.respond(userId, 'refunded', record.productId, 0);
    }

    const result = await this.grantPurchase(userId, record);
    return this.respond(userId, result.status, record.productId, result.gemsGranted);
  }

  async verifyGoogle(
    userId: string,
    productId: string,
    purchaseToken: string,
  ): Promise<VerifyPurchaseResponse> {
    const purchase = await this.google.getProductPurchase(productId, purchaseToken);
    if (!sameId(purchase.obfuscatedExternalAccountId, userId)) {
      throw new ForbiddenException('Purchase belongs to another account');
    }
    if (purchase.purchaseState === GOOGLE_PENDING) {
      return this.respond(userId, 'pending', productId, 0);
    }

    const record = googleRecord(productId, purchaseToken, purchase);
    if (purchase.purchaseState === GOOGLE_CANCELED) {
      await this.refundPurchase(record, userId, new Date());
      return this.respond(userId, 'refunded', productId, 0);
    }
    if (purchase.purchaseState !== GOOGLE_PURCHASED) {
      throw new BadRequestException('Google Play purchase is not completed');
    }

    const result = await this.grantPurchase(userId, record);
    if (result.status !== 'refunded' && purchase.consumptionState === GOOGLE_NOT_CONSUMED) {
      await this.google.consume(productId, purchaseToken);
    }
    const response = await this.respond(userId, result.status, productId, result.gemsGranted);
    if (result.status === 'duplicate') {
      const prior = await this.prisma.iapPurchase.findUniqueOrThrow({
        where: { platform_storeTransactionId: key(record) },
        select: { gemsGranted: true },
      });
      response.purchaseCredit = prior.gemsGranted;
    } else {
      response.purchaseCredit = result.gemsGranted;
    }
    return response;
  }

  /** App Store Server Notifications V2. Throws 401 on an invalid signature. */
  async handleAppleNotification(
    signedPayload: string,
    environment: IapEnvironment,
  ): Promise<NotificationOutcome> {
    const notification = await this.apple.verifyNotification(signedPayload, environment);
    const type = notification.notificationType;

    if (
      type !== NotificationTypeV2.ONE_TIME_CHARGE &&
      type !== NotificationTypeV2.REFUND &&
      type !== NotificationTypeV2.REFUND_REVERSED
    ) {
      this.logger.log(`Apple notification ignored type=${type} env=${environment}`);
      return 'ignored';
    }

    const signed = notification.data?.signedTransactionInfo;
    if (!signed) return 'ignored';
    const transaction = await this.apple.verifyTransaction(signed, environment);
    if (transaction.type !== AppleProductType.CONSUMABLE) return 'ignored';

    return this.ignoreClientErrors(async () => {
      const record = this.appleRecord(transaction, environment);
      const userId = await this.resolveUser(transaction.appAccountToken);
      const signedAt = new Date(
        notification.signedDate ??
          transaction.signedDate ??
          transaction.revocationDate ??
          Date.now(),
      );
      if (type === NotificationTypeV2.REFUND_REVERSED) {
        return this.reverseRefund(record, userId, signedAt);
      }
      if (type === NotificationTypeV2.REFUND) {
        const refundedAt = new Date(transaction.revocationDate ?? Date.now());
        return this.refundPurchase(record, userId, refundedAt, signedAt);
      }
      if (!userId) return 'ignored';
      const result = await this.grantPurchase(userId, record);
      return result.status === 'granted' ? 'granted' : 'duplicate';
    });
  }

  /** Google Play RTDN delivered by a Pub/Sub push subscription. */
  async handleGoogleRtdn(
    authorization: string | undefined,
    body: PubSubPushDto,
  ): Promise<NotificationOutcome> {
    await this.pubsub.verify(authorization);

    const payload = decodeRtdn(body.message?.data);
    if (!payload || payload.packageName !== this.google.packageName) return 'ignored';
    if (payload.testNotification) {
      this.logger.log('Google RTDN test notification received');
      return 'ignored';
    }

    const oneTime = payload.oneTimeProductNotification;
    if (
      oneTime?.notificationType === RTDN_ONE_TIME_PURCHASED &&
      oneTime.purchaseToken &&
      oneTime.sku
    ) {
      const { sku, purchaseToken } = oneTime;
      const purchase = await this.google.getProductPurchase(sku, purchaseToken);
      if (purchase.purchaseState !== GOOGLE_PURCHASED) return 'ignored';
      const userId = await this.resolveUser(purchase.obfuscatedExternalAccountId);
      if (!userId) return 'ignored';

      return this.ignoreClientErrors(async () => {
        const result = await this.grantPurchase(userId, googleRecord(sku, purchaseToken, purchase));
        if (result.status !== 'refunded' && purchase.consumptionState === GOOGLE_NOT_CONSUMED) {
          await this.google.consume(sku, purchaseToken);
        }
        return result.status === 'granted' ? 'granted' : 'duplicate';
      });
    }

    const voided = payload.voidedPurchaseNotification;
    if (voided?.purchaseToken && voided.productType === RTDN_PRODUCT_TYPE_ONE_TIME) {
      return this.refundPurchase(
        { platform: IapPlatform.GOOGLE, storeTransactionId: voided.purchaseToken },
        null,
        new Date(),
      );
    }

    return 'ignored';
  }

  private async grantPurchase(userId: string, record: PurchaseRecord): Promise<GrantResult> {
    const pack = await this.findGemPack(record.productId, record.platform);
    const gems = this.gemsFor(pack, record.environment);
    try {
      await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await lockPurchase(tx, record);
        await tx.iapPurchase.create({
          data: { ...record, userId, gemsGranted: gems },
        });
        if (gems > 0) {
          await tx.user.update({
            where: { id: userId },
            data: { gems: { increment: gems } },
          });
        }
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.prisma.iapPurchase.findUnique({
        where: { platform_storeTransactionId: key(record) },
      });
      if (!existing || (existing.userId !== null && existing.userId !== userId)) {
        throw new ConflictException('Purchase already claimed by another account');
      }
      return {
        status: existing.status === IapPurchaseStatus.REFUNDED ? 'refunded' : 'duplicate',
        gemsGranted: 0,
      };
    }

    this.logger.log(
      `IAP granted user=${userId} platform=${record.platform} env=${record.environment} product=${record.productId} gems=${gems}`,
    );
    return { status: 'granted', gemsGranted: gems };
  }

  /**
   * Flips GRANTED -> REFUNDED and takes the credited gems back. When the store
   * reports the refund before we ever credited it, a REFUNDED row with 0 gems
   * is stored so a later verify can't credit the purchase.
   */
  private async refundPurchase(
    record: PurchaseRecord | PurchaseKey,
    userId: string | null,
    refundedAt: Date,
    signedAt = refundedAt,
  ): Promise<NotificationOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await lockPurchase(tx, record);
      const where = { platform_storeTransactionId: key(record) };
      const existing = await tx.iapPurchase.findUnique({ where });
      if (!existing) {
        // A Google void can arrive with just the token, before the client verifies the purchase.
        if (!userId && record.platform !== IapPlatform.GOOGLE) return 'ignored';
        await tx.iapPurchase.create({
          data: {
            ...record,
            userId,
            gemsGranted: 0,
            status: IapPurchaseStatus.REFUNDED,
            refundedAt,
            lastAdjustmentAt: signedAt,
          },
        });
        return 'refunded';
      }
      if (existing.lastAdjustmentAt && existing.lastAdjustmentAt >= signedAt) return 'duplicate';
      await tx.iapPurchase.update({
        where,
        data: { status: IapPurchaseStatus.REFUNDED, refundedAt, lastAdjustmentAt: signedAt },
      });
      if (existing.status === IapPurchaseStatus.REFUNDED) return 'duplicate';
      if (existing.userId && existing.gemsGranted > 0) {
        await tx.user.update({
          where: { id: existing.userId },
          data: { gems: { decrement: existing.gemsGranted } },
        });
      }
      return 'refunded';
    });
  }

  private async reverseRefund(
    record: PurchaseRecord,
    userId: string | null,
    signedAt: Date,
  ): Promise<NotificationOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await lockPurchase(tx, record);
      const where = { platform_storeTransactionId: key(record) };
      const existing = await tx.iapPurchase.findUnique({ where });
      if (existing?.lastAdjustmentAt && existing.lastAdjustmentAt >= signedAt) return 'duplicate';
      if (existing?.status === IapPurchaseStatus.GRANTED) {
        await tx.iapPurchase.update({ where, data: { lastAdjustmentAt: signedAt } });
        return 'duplicate';
      }
      const owner = existing?.userId ?? userId;
      if (!owner) return 'ignored';
      let gems = existing?.gemsGranted ?? 0;
      if (!gems) {
        const pack = await tx.gemPackDefinition.findUnique({
          where: { platform_productId: { platform: record.platform, productId: record.productId } },
        });
        if (!pack || (!existing && !pack.isEnabled)) return 'ignored';
        gems = this.gemsFor(pack, record.environment);
      }
      const data = {
        status: IapPurchaseStatus.GRANTED,
        refundedAt: null,
        gemsGranted: gems,
        lastAdjustmentAt: signedAt,
      };
      if (existing) {
        await tx.iapPurchase.update({ where, data });
      } else {
        await tx.iapPurchase.create({ data: { ...record, ...data, userId: owner } });
      }
      if (gems > 0)
        await tx.user.update({ where: { id: owner }, data: { gems: { increment: gems } } });
      return 'reversed';
    });
  }

  private async findGemPack(productId: string, platform: IapPlatform): Promise<GemPackDefinition> {
    const pack = await this.prisma.gemPackDefinition.findUnique({
      where: { platform_productId: { platform, productId } },
    });
    if (!pack || !pack.isEnabled) {
      throw new BadRequestException(`Unknown product "${productId}"`);
    }
    return pack;
  }

  private appleRecord(
    transaction: JWSTransactionDecodedPayload,
    environment: IapEnvironment,
  ): PurchaseRecord {
    if (!transaction.transactionId || !transaction.productId) {
      throw new BadRequestException('Apple transaction is missing identifiers');
    }
    if (transaction.quantity != null && transaction.quantity !== 1)
      throw new BadRequestException('Expected one consumable per transaction');
    if (transaction.type !== AppleProductType.CONSUMABLE) {
      throw new BadRequestException('Only consumable products are supported');
    }
    return {
      platform: IapPlatform.APPLE,
      environment,
      productId: transaction.productId,
      storeTransactionId: transaction.transactionId,
      orderId: null,
      purchasedAt: new Date(transaction.purchaseDate ?? Date.now()),
      rawPayload: transaction as unknown as Prisma.InputJsonValue,
    };
  }

  private async resolveUser(candidate: string | null | undefined): Promise<string | null> {
    if (!candidate || !UUID_RE.test(candidate)) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: candidate.toLowerCase() },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  /** Store webhooks: 4xx business errors are acked (logged) so the store doesn't retry forever. */
  private async ignoreClientErrors(
    fn: () => Promise<NotificationOutcome>,
  ): Promise<NotificationOutcome> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() < 500) {
        this.logger.warn(`Store notification ignored: ${err.message}`);
        return 'ignored';
      }
      throw err;
    }
  }

  private async respond(
    userId: string,
    status: VerifyStatus,
    productId: string,
    gemsGranted: number,
  ): Promise<VerifyPurchaseResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { gems: true, coins: true },
    });
    return { status, productId, gemsGranted, gems: user.gems, coins: user.coins };
  }
}

function googleRecord(
  productId: string,
  purchaseToken: string,
  purchase: GoogleProductPurchase,
): PurchaseRecord {
  if (purchase.productId && purchase.productId !== productId)
    throw new BadRequestException('Unexpected Google Play product');
  if (purchase.quantity != null && purchase.quantity !== 1)
    throw new BadRequestException('Expected one consumable per transaction');
  return {
    platform: IapPlatform.GOOGLE,
    environment:
      purchase.purchaseType === GOOGLE_TEST_PURCHASE
        ? IapEnvironment.SANDBOX
        : IapEnvironment.PRODUCTION,
    productId,
    storeTransactionId: purchaseToken,
    orderId: purchase.orderId ?? null,
    purchasedAt: new Date(Number(purchase.purchaseTimeMillis ?? Date.now())),
    rawPayload: purchase as unknown as Prisma.InputJsonValue,
  };
}

function decodeRtdn(data: unknown): RtdnPayload | null {
  if (typeof data !== 'string' || !data) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as RtdnPayload) : null;
  } catch {
    return null;
  }
}

function key(record: PurchaseKey): PurchaseKey {
  return { platform: record.platform, storeTransactionId: record.storeTransactionId };
}

function sameId(candidate: string | null | undefined, userId: string): boolean {
  return !!candidate && candidate.toLowerCase() === userId.toLowerCase();
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// Serialize the store events even when the first event has no purchase row to lock.
async function lockPurchase(tx: Prisma.TransactionClient, record: PurchaseKey): Promise<void> {
  const id = record.platform + ':' + record.storeTransactionId;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
}
