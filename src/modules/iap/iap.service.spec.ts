import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { NotificationTypeV2, Type as AppleProductType } from '@apple/app-store-server-library';
import { IapEnvironment, IapPlatform, IapPurchaseStatus, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { mockDeep, MockProxy } from 'jest-mock-extended';
import { PrismaService } from '../prisma/prisma.service';
import { AppleStoreClient } from './apple/apple-store.client';
import { GooglePlayClient } from './google/google-play.client';
import { PubSubPushVerifier } from './google/pubsub-push.verifier';
import { IapService } from './iap.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const APPLE_PRODUCT = 'test.pier.pack.100g';
const GOOGLE_PRODUCT = 'test.pier.pack.220g';
const TOKEN = 'google-purchase-token-abcdefghijklmnop';

const applePack = {
  id: 'p1',
  productId: APPLE_PRODUCT,
  platform: IapPlatform.APPLE,
  gems: 100,
  isEnabled: true,
};
const googlePack = {
  id: 'p2',
  productId: GOOGLE_PRODUCT,
  platform: IapPlatform.GOOGLE,
  gems: 220,
  isEnabled: true,
};

function appleTx(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: '2000000123456789',
    productId: APPLE_PRODUCT,
    type: AppleProductType.CONSUMABLE,
    appAccountToken: USER_ID,
    purchaseDate: 1_700_000_000_000,
    ...overrides,
  };
}

function googlePurchase(overrides: Record<string, unknown> = {}) {
  return {
    purchaseState: 0,
    consumptionState: 0,
    obfuscatedExternalAccountId: USER_ID,
    orderId: 'GPA.1234',
    purchaseTimeMillis: '1700000000000',
    ...overrides,
  };
}

function rtdn(payload: Record<string, unknown>) {
  return { message: { data: Buffer.from(JSON.stringify(payload)).toString('base64') } };
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
}

describe('IapService', () => {
  let prisma: MockProxy<PrismaService>;
  let apple: MockProxy<AppleStoreClient>;
  let google: MockProxy<GooglePlayClient>;
  let pubsub: MockProxy<PubSubPushVerifier>;
  let service: IapService;
  let creditSandbox: boolean;

  const mock = (fn: unknown) => fn as unknown as jest.Mock;

  beforeEach(() => {
    creditSandbox = true;
    prisma = mockDeep<PrismaService>();
    apple = mockDeep<AppleStoreClient>();
    google = mockDeep<GooglePlayClient>();
    pubsub = mockDeep<PubSubPushVerifier>();
    Object.defineProperty(google, 'packageName', { get: () => 'com.test.pier' });

    mock(prisma.$transaction).mockImplementation(async (cb: unknown) =>
      (cb as (c: unknown) => unknown)(prisma),
    );
    mock(prisma.gemPackDefinition.findUnique).mockImplementation(
      async ({
        where,
      }: {
        where: { platform_productId: { platform: IapPlatform; productId: string } };
      }) =>
        [applePack, googlePack].find(
          (p) =>
            p.platform === where.platform_productId.platform &&
            p.productId === where.platform_productId.productId,
        ) ?? null,
    );
    mock(prisma.iapPurchase.create).mockResolvedValue({});
    mock(prisma.user.update).mockResolvedValue({});
    mock(prisma.user.findUniqueOrThrow).mockResolvedValue({ gems: 100, coins: 7 });
    mock(prisma.user.findUnique).mockResolvedValue({ id: USER_ID });
    pubsub.verify.mockResolvedValue(undefined);
    google.consume.mockResolvedValue(undefined);

    service = new IapService(
      prisma as unknown as PrismaService,
      apple as unknown as AppleStoreClient,
      google as unknown as GooglePlayClient,
      pubsub as unknown as PubSubPushVerifier,
      { get: () => creditSandbox } as unknown as ConfigService,
    );
  });

  describe('verifyApple', () => {
    beforeEach(() => {
      apple.getVerifiedTransaction.mockResolvedValue({
        transaction: appleTx(),
        environment: IapEnvironment.SANDBOX,
      } as never);
    });

    it('records a sandbox purchase with 0 gems and no balance change when IAP_CREDIT_SANDBOX is off', async () => {
      creditSandbox = false;
      mock(prisma.user.findUniqueOrThrow).mockResolvedValue({ gems: 0, coins: 7 });

      const out = await service.verifyApple(USER_ID, '2000000123456789');

      expect(out).toEqual({
        status: 'granted',
        productId: APPLE_PRODUCT,
        gemsGranted: 0,
        gems: 0,
        coins: 7,
      });
      expect(prisma.iapPurchase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ environment: IapEnvironment.SANDBOX, gemsGranted: 0 }),
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('still credits PRODUCTION purchases when IAP_CREDIT_SANDBOX is off', async () => {
      creditSandbox = false;
      apple.getVerifiedTransaction.mockResolvedValueOnce({
        transaction: appleTx(),
        environment: IapEnvironment.PRODUCTION,
      } as never);

      const out = await service.verifyApple(USER_ID, '2000000123456789');

      expect(out.gemsGranted).toBe(100);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { gems: { increment: 100 } },
      });
    });

    it('credits the pack gems once and returns the authoritative balance', async () => {
      const out = await service.verifyApple(USER_ID, '2000000123456789');

      expect(out).toEqual({
        status: 'granted',
        productId: APPLE_PRODUCT,
        gemsGranted: 100,
        gems: 100,
        coins: 7,
      });
      expect(prisma.iapPurchase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: USER_ID,
          platform: IapPlatform.APPLE,
          environment: IapEnvironment.SANDBOX,
          storeTransactionId: '2000000123456789',
          gemsGranted: 100,
        }),
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { gems: { increment: 100 } },
      });
    });

    it('returns duplicate for a transaction already credited to the same user', async () => {
      mock(prisma.$transaction).mockRejectedValueOnce(uniqueViolation());
      mock(prisma.iapPurchase.findUnique).mockResolvedValue({
        userId: USER_ID,
        status: IapPurchaseStatus.GRANTED,
      });

      const out = await service.verifyApple(USER_ID, '2000000123456789');
      expect(out.status).toBe('duplicate');
      expect(out.gemsGranted).toBe(0);
    });

    it('returns refunded when the stored purchase was already refunded', async () => {
      mock(prisma.$transaction).mockRejectedValueOnce(uniqueViolation());
      mock(prisma.iapPurchase.findUnique).mockResolvedValue({
        userId: USER_ID,
        status: IapPurchaseStatus.REFUNDED,
      });

      await expect(service.verifyApple(USER_ID, 'x')).resolves.toMatchObject({
        status: 'refunded',
      });
    });

    it('rejects with 409 when another account already claimed the transaction', async () => {
      mock(prisma.$transaction).mockRejectedValueOnce(uniqueViolation());
      mock(prisma.iapPurchase.findUnique).mockResolvedValue({
        userId: OTHER_USER,
        status: IapPurchaseStatus.GRANTED,
      });

      await expect(service.verifyApple(USER_ID, 'x')).rejects.toBeInstanceOf(ConflictException);
    });

    it('rethrows unexpected database errors', async () => {
      mock(prisma.$transaction).mockRejectedValueOnce(new Error('db down'));
      await expect(service.verifyApple(USER_ID, 'x')).rejects.toThrow('db down');
    });

    it('rejects with 403 when appAccountToken is missing or belongs to someone else', async () => {
      apple.getVerifiedTransaction.mockResolvedValueOnce({
        transaction: appleTx({ appAccountToken: OTHER_USER }),
        environment: IapEnvironment.PRODUCTION,
      } as never);
      await expect(service.verifyApple(USER_ID, 'x')).rejects.toBeInstanceOf(ForbiddenException);

      apple.getVerifiedTransaction.mockResolvedValueOnce({
        transaction: appleTx({ appAccountToken: undefined }),
        environment: IapEnvironment.PRODUCTION,
      } as never);
      await expect(service.verifyApple(USER_ID, 'x')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects unknown, disabled, or non-consumable products with 400', async () => {
      apple.getVerifiedTransaction.mockResolvedValueOnce({
        transaction: appleTx({ productId: 'com.unknown' }),
        environment: IapEnvironment.PRODUCTION,
      } as never);
      await expect(service.verifyApple(USER_ID, 'x')).rejects.toBeInstanceOf(BadRequestException);

      mock(prisma.gemPackDefinition.findUnique).mockResolvedValueOnce({
        ...applePack,
        isEnabled: false,
      });
      await expect(service.verifyApple(USER_ID, 'x')).rejects.toBeInstanceOf(BadRequestException);

      apple.getVerifiedTransaction.mockResolvedValueOnce({
        transaction: appleTx({ type: AppleProductType.NON_CONSUMABLE }),
        environment: IapEnvironment.PRODUCTION,
      } as never);
      await expect(service.verifyApple(USER_ID, 'x')).rejects.toBeInstanceOf(BadRequestException);

      apple.getVerifiedTransaction.mockResolvedValueOnce({
        transaction: appleTx({ transactionId: undefined }),
        environment: IapEnvironment.PRODUCTION,
      } as never);
      await expect(service.verifyApple(USER_ID, 'x')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('records a revoked transaction as refunded without crediting', async () => {
      apple.getVerifiedTransaction.mockResolvedValueOnce({
        transaction: appleTx({ revocationDate: 1_700_000_100_000 }),
        environment: IapEnvironment.PRODUCTION,
      } as never);
      mock(prisma.iapPurchase.findUnique).mockResolvedValue(null);

      const out = await service.verifyApple(USER_ID, 'x');

      expect(out.status).toBe('refunded');
      expect(prisma.iapPurchase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ gemsGranted: 0, status: IapPurchaseStatus.REFUNDED }),
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('verifyGoogle', () => {
    it('credits, consumes and stores test purchases as SANDBOX', async () => {
      google.getProductPurchase.mockResolvedValue(googlePurchase({ purchaseType: 0 }) as never);

      const out = await service.verifyGoogle(USER_ID, GOOGLE_PRODUCT, TOKEN);

      expect(out).toMatchObject({ status: 'granted', gemsGranted: 220 });
      expect(prisma.iapPurchase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          platform: IapPlatform.GOOGLE,
          environment: IapEnvironment.SANDBOX,
          storeTransactionId: TOKEN,
          orderId: 'GPA.1234',
        }),
      });
      expect(google.consume).toHaveBeenCalledWith(GOOGLE_PRODUCT, TOKEN);
    });

    it('stores real purchases as PRODUCTION and skips consume when already consumed', async () => {
      google.getProductPurchase.mockResolvedValue(
        googlePurchase({ consumptionState: 1, orderId: undefined }) as never,
      );

      await service.verifyGoogle(USER_ID, GOOGLE_PRODUCT, TOKEN);

      expect(prisma.iapPurchase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ environment: IapEnvironment.PRODUCTION, orderId: null }),
      });
      expect(google.consume).not.toHaveBeenCalled();
    });

    it('propagates a failed consume so the delivery can retry', async () => {
      google.getProductPurchase.mockResolvedValue(googlePurchase() as never);
      google.consume.mockRejectedValueOnce(new Error('boom'));

      await expect(service.verifyGoogle(USER_ID, GOOGLE_PRODUCT, TOKEN)).rejects.toThrow('boom');
    });

    it('returns pending without crediting', async () => {
      google.getProductPurchase.mockResolvedValue(googlePurchase({ purchaseState: 2 }) as never);

      const out = await service.verifyGoogle(USER_ID, GOOGLE_PRODUCT, TOKEN);
      expect(out.status).toBe('pending');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('records canceled purchases as refunded', async () => {
      google.getProductPurchase.mockResolvedValue(googlePurchase({ purchaseState: 1 }) as never);
      mock(prisma.iapPurchase.findUnique).mockResolvedValue(null);

      await expect(service.verifyGoogle(USER_ID, GOOGLE_PRODUCT, TOKEN)).resolves.toMatchObject({
        status: 'refunded',
      });
    });

    it('rejects unknown purchase states with 400', async () => {
      google.getProductPurchase.mockResolvedValue(googlePurchase({ purchaseState: 9 }) as never);
      await expect(service.verifyGoogle(USER_ID, GOOGLE_PRODUCT, TOKEN)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects with 403 when obfuscatedExternalAccountId does not match', async () => {
      google.getProductPurchase.mockResolvedValue(
        googlePurchase({ obfuscatedExternalAccountId: OTHER_USER }) as never,
      );
      await expect(service.verifyGoogle(USER_ID, GOOGLE_PRODUCT, TOKEN)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects an Apple product id on the Google route', async () => {
      google.getProductPurchase.mockResolvedValue(googlePurchase() as never);
      await expect(service.verifyGoogle(USER_ID, APPLE_PRODUCT, TOKEN)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('does not consume a purchase that was refunded before crediting', async () => {
      google.getProductPurchase.mockResolvedValue(googlePurchase() as never);
      mock(prisma.$transaction).mockRejectedValueOnce(uniqueViolation());
      mock(prisma.iapPurchase.findUnique).mockResolvedValue({
        userId: USER_ID,
        status: IapPurchaseStatus.REFUNDED,
      });

      await expect(service.verifyGoogle(USER_ID, GOOGLE_PRODUCT, TOKEN)).resolves.toMatchObject({
        status: 'refunded',
      });
      expect(google.consume).not.toHaveBeenCalled();
    });
  });

  describe('handleAppleNotification', () => {
    function notify(type: NotificationTypeV2 | string, tx = appleTx()) {
      apple.verifyNotification.mockResolvedValue({
        notificationType: type,
        data: { signedTransactionInfo: 'signed-tx' },
      } as never);
      apple.verifyTransaction.mockResolvedValue(tx as never);
    }

    it('propagates signature failures (401)', async () => {
      apple.verifyNotification.mockRejectedValue(new UnauthorizedException());
      await expect(
        service.handleAppleNotification('bad', IapEnvironment.PRODUCTION),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('ignores TEST and unrelated notification types', async () => {
      notify(NotificationTypeV2.TEST);
      await expect(service.handleAppleNotification('p', IapEnvironment.SANDBOX)).resolves.toBe(
        'ignored',
      );
      notify(NotificationTypeV2.DID_RENEW);
      await expect(service.handleAppleNotification('p', IapEnvironment.SANDBOX)).resolves.toBe(
        'ignored',
      );
    });

    it('ignores notifications without transaction info or for non-consumables', async () => {
      apple.verifyNotification.mockResolvedValue({
        notificationType: NotificationTypeV2.REFUND,
        data: {},
      } as never);
      await expect(service.handleAppleNotification('p', IapEnvironment.SANDBOX)).resolves.toBe(
        'ignored',
      );

      notify(NotificationTypeV2.REFUND, appleTx({ type: AppleProductType.NON_CONSUMABLE }));
      await expect(service.handleAppleNotification('p', IapEnvironment.SANDBOX)).resolves.toBe(
        'ignored',
      );
    });

    it('credits ONE_TIME_CHARGE for a known appAccountToken', async () => {
      notify(NotificationTypeV2.ONE_TIME_CHARGE);
      await expect(service.handleAppleNotification('p', IapEnvironment.PRODUCTION)).resolves.toBe(
        'granted',
      );
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { gems: { increment: 100 } },
      });
    });

    it('reports duplicate ONE_TIME_CHARGE after the verify call credited it', async () => {
      notify(NotificationTypeV2.ONE_TIME_CHARGE);
      mock(prisma.$transaction).mockRejectedValueOnce(uniqueViolation());
      mock(prisma.iapPurchase.findUnique).mockResolvedValue({
        userId: USER_ID,
        status: IapPurchaseStatus.GRANTED,
      });
      await expect(service.handleAppleNotification('p', IapEnvironment.PRODUCTION)).resolves.toBe(
        'duplicate',
      );
    });

    it('ignores ONE_TIME_CHARGE for unknown or malformed accounts', async () => {
      notify(NotificationTypeV2.ONE_TIME_CHARGE, appleTx({ appAccountToken: 'not-a-uuid' }));
      await expect(service.handleAppleNotification('p', IapEnvironment.PRODUCTION)).resolves.toBe(
        'ignored',
      );

      notify(NotificationTypeV2.ONE_TIME_CHARGE);
      mock(prisma.user.findUnique).mockResolvedValueOnce(null);
      await expect(service.handleAppleNotification('p', IapEnvironment.PRODUCTION)).resolves.toBe(
        'ignored',
      );
    });

    it('acks (ignores) business errors such as an unknown product', async () => {
      notify(NotificationTypeV2.ONE_TIME_CHARGE, appleTx({ productId: 'com.unknown' }));
      await expect(service.handleAppleNotification('p', IapEnvironment.PRODUCTION)).resolves.toBe(
        'ignored',
      );
    });

    it('REFUND takes the credited gems back, allowing a negative balance', async () => {
      notify(NotificationTypeV2.REFUND, appleTx({ revocationDate: 1_700_000_100_000 }));
      mock(prisma.iapPurchase.findUnique).mockResolvedValue({
        id: 'row',
        userId: USER_ID,
        platform: IapPlatform.APPLE,
        storeTransactionId: '2000000123456789',
        gemsGranted: 100,
      });

      await expect(service.handleAppleNotification('p', IapEnvironment.PRODUCTION)).resolves.toBe(
        'refunded',
      );
      expect(prisma.iapPurchase.update).toHaveBeenCalledWith({
        where: expect.any(Object),
        data: expect.objectContaining({
          status: IapPurchaseStatus.REFUNDED,
          refundedAt: new Date(1_700_000_100_000),
        }),
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { gems: { decrement: 100 } },
      });
    });

    it('a repeated REFUND does not decrement twice', async () => {
      notify(NotificationTypeV2.REFUND);
      mock(prisma.iapPurchase.findUnique).mockResolvedValue({
        status: IapPurchaseStatus.REFUNDED,
        id: 'row',
        userId: USER_ID,
        gemsGranted: 100,
      });

      await expect(service.handleAppleNotification('p', IapEnvironment.PRODUCTION)).resolves.toBe(
        'duplicate',
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('REFUND for an unknown purchase and unknown user is ignored', async () => {
      notify(NotificationTypeV2.REFUND);
      mock(prisma.iapPurchase.findUnique).mockResolvedValue(null);
      mock(prisma.user.findUnique).mockResolvedValue(null);

      await expect(service.handleAppleNotification('p', IapEnvironment.PRODUCTION)).resolves.toBe(
        'ignored',
      );
    });

    it('REFUND_REVERSED re-credits the gems', async () => {
      notify(NotificationTypeV2.REFUND_REVERSED);
      mock(prisma.iapPurchase.findUnique).mockResolvedValue({
        id: 'row',
        userId: USER_ID,
        productId: APPLE_PRODUCT,
        gemsGranted: 100,
      });

      await expect(service.handleAppleNotification('p', IapEnvironment.PRODUCTION)).resolves.toBe(
        'reversed',
      );
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { gems: { increment: 100 } },
      });
    });

    it('REFUND_REVERSED of a refund-before-grant row credits the catalog amount', async () => {
      notify(NotificationTypeV2.REFUND_REVERSED);
      mock(prisma.iapPurchase.findUnique).mockResolvedValue({
        id: 'row',
        userId: USER_ID,
        platform: IapPlatform.APPLE,
        environment: IapEnvironment.PRODUCTION,
        productId: APPLE_PRODUCT,
        gemsGranted: 0,
      });

      await service.handleAppleNotification('p', IapEnvironment.PRODUCTION);
      expect(prisma.iapPurchase.update).toHaveBeenCalledWith({
        where: expect.any(Object),
        data: {
          lastAdjustmentAt: expect.any(Date),
          status: IapPurchaseStatus.GRANTED,
          refundedAt: null,
          gemsGranted: 100,
        },
      });
    });

    it('REFUND_REVERSED of a sandbox row credits nothing while IAP_CREDIT_SANDBOX is off', async () => {
      creditSandbox = false;
      notify(NotificationTypeV2.REFUND_REVERSED);
      mock(prisma.iapPurchase.findUnique).mockResolvedValue({
        id: 'row',
        userId: USER_ID,
        platform: IapPlatform.APPLE,
        environment: IapEnvironment.SANDBOX,
        productId: APPLE_PRODUCT,
        gemsGranted: 0,
      });

      await service.handleAppleNotification('p', IapEnvironment.SANDBOX);
      expect(prisma.iapPurchase.update).toHaveBeenCalledWith({
        where: expect.any(Object),
        data: {
          lastAdjustmentAt: expect.any(Date),
          status: IapPurchaseStatus.GRANTED,
          refundedAt: null,
          gemsGranted: 0,
        },
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('REFUND_REVERSED is a no-op when unknown or already granted', async () => {
      notify(NotificationTypeV2.REFUND_REVERSED);
      mock(prisma.user.findUnique).mockResolvedValueOnce(null);
      mock(prisma.iapPurchase.findUnique).mockResolvedValueOnce(null);
      await expect(service.handleAppleNotification('p', IapEnvironment.PRODUCTION)).resolves.toBe(
        'ignored',
      );

      mock(prisma.iapPurchase.findUnique).mockResolvedValueOnce({
        id: 'row',
        status: IapPurchaseStatus.GRANTED,
        userId: USER_ID,
        gemsGranted: 100,
      });
      await expect(service.handleAppleNotification('p', IapEnvironment.PRODUCTION)).resolves.toBe(
        'duplicate',
      );
    });
  });

  describe('handleGoogleRtdn', () => {
    const pkg = 'com.test.pier';

    it('rejects when the Pub/Sub token is invalid', async () => {
      pubsub.verify.mockRejectedValue(new UnauthorizedException());
      await expect(service.handleGoogleRtdn('Bearer bad', rtdn({}))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('ignores malformed data, other packages and test notifications', async () => {
      await expect(
        service.handleGoogleRtdn('Bearer t', { message: { data: '%%%' } }),
      ).resolves.toBe('ignored');
      await expect(service.handleGoogleRtdn('Bearer t', { message: {} })).resolves.toBe('ignored');
      await expect(
        service.handleGoogleRtdn('Bearer t', rtdn({ packageName: 'other' })),
      ).resolves.toBe('ignored');
      await expect(
        service.handleGoogleRtdn(
          'Bearer t',
          rtdn({ packageName: pkg, testNotification: { version: '1.0' } }),
        ),
      ).resolves.toBe('ignored');
      await expect(service.handleGoogleRtdn('Bearer t', rtdn({ packageName: pkg }))).resolves.toBe(
        'ignored',
      );
    });

    it('credits a PURCHASED one-time product as backup and consumes it', async () => {
      google.getProductPurchase.mockResolvedValue(googlePurchase() as never);

      const out = await service.handleGoogleRtdn(
        'Bearer t',
        rtdn({
          packageName: pkg,
          oneTimeProductNotification: {
            notificationType: 1,
            purchaseToken: TOKEN,
            sku: GOOGLE_PRODUCT,
          },
        }),
      );

      expect(out).toBe('granted');
      expect(google.consume).toHaveBeenCalledWith(GOOGLE_PRODUCT, TOKEN);
    });

    it('reports duplicate when the verify call already credited it', async () => {
      google.getProductPurchase.mockResolvedValue(googlePurchase({ consumptionState: 1 }) as never);
      mock(prisma.$transaction).mockRejectedValueOnce(uniqueViolation());
      mock(prisma.iapPurchase.findUnique).mockResolvedValue({
        userId: USER_ID,
        status: IapPurchaseStatus.GRANTED,
      });

      await expect(
        service.handleGoogleRtdn(
          'Bearer t',
          rtdn({
            packageName: pkg,
            oneTimeProductNotification: {
              notificationType: 1,
              purchaseToken: TOKEN,
              sku: GOOGLE_PRODUCT,
            },
          }),
        ),
      ).resolves.toBe('duplicate');
    });

    it('ignores PURCHASED notifications that are not completed or have no known account', async () => {
      const body = rtdn({
        packageName: pkg,
        oneTimeProductNotification: {
          notificationType: 1,
          purchaseToken: TOKEN,
          sku: GOOGLE_PRODUCT,
        },
      });

      google.getProductPurchase.mockResolvedValueOnce(
        googlePurchase({ purchaseState: 2 }) as never,
      );
      await expect(service.handleGoogleRtdn('Bearer t', body)).resolves.toBe('ignored');

      google.getProductPurchase.mockResolvedValueOnce(
        googlePurchase({ obfuscatedExternalAccountId: undefined }) as never,
      );
      await expect(service.handleGoogleRtdn('Bearer t', body)).resolves.toBe('ignored');
    });

    it('takes gems back on a voided one-time purchase', async () => {
      mock(prisma.iapPurchase.findUnique).mockResolvedValue({
        id: 'row',
        userId: USER_ID,
        platform: IapPlatform.GOOGLE,
        storeTransactionId: TOKEN,
        gemsGranted: 220,
      });

      const out = await service.handleGoogleRtdn(
        'Bearer t',
        rtdn({
          packageName: pkg,
          voidedPurchaseNotification: { purchaseToken: TOKEN, orderId: 'GPA.1', productType: 2 },
        }),
      );

      expect(out).toBe('refunded');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { gems: { decrement: 220 } },
      });
    });

    it('records a void before purchase verification', async () => {
      mock(prisma.iapPurchase.findUnique).mockResolvedValue(null);
      await expect(
        service.handleGoogleRtdn(
          'Bearer t',
          rtdn({
            packageName: pkg,
            voidedPurchaseNotification: { purchaseToken: TOKEN, productType: 2 },
          }),
        ),
      ).resolves.toBe('refunded');
    });
  });
});
