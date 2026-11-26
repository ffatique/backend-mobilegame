import './setup-env';

import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { NotificationTypeV2, Type as AppleProductType } from '@apple/app-store-server-library';
import { IapEnvironment, IapPlatform, IapPurchaseStatus, Prisma } from '@prisma/client';
import { mockDeep, MockProxy } from 'jest-mock-extended';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AppleStoreClient } from '../src/modules/iap/apple/apple-store.client';
import { GooglePlayClient } from '../src/modules/iap/google/google-play.client';
import { PubSubPushVerifier } from '../src/modules/iap/google/pubsub-push.verifier';
import { PrismaService } from '../src/modules/prisma/prisma.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const APPLE_PRODUCT = 'test.pier.pack.220g';
// Same store product id on both platforms; the catalog is keyed by (platform, productId).
const GOOGLE_PRODUCT = APPLE_PRODUCT;
const TOKEN = 'purchase-token-0123456789';

const PACKS = [
  { id: 'a', productId: APPLE_PRODUCT, platform: IapPlatform.APPLE, gems: 220, isEnabled: true },
  { id: 'g', productId: GOOGLE_PRODUCT, platform: IapPlatform.GOOGLE, gems: 1390, isEnabled: true },
];

function appleTx(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: '2000000999',
    productId: APPLE_PRODUCT,
    type: AppleProductType.CONSUMABLE,
    appAccountToken: USER_ID,
    purchaseDate: 1_700_000_000_000,
    ...overrides,
  };
}

function rtdn(payload: Record<string, unknown>) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(payload)).toString('base64'),
      messageId: '1',
      publishTime: '2026-10-16T00:00:00Z',
    },
    subscription: 'projects/p/subscriptions/s',
  };
}

describe('IAP (e2e)', () => {
  let app: INestApplication;
  let prisma: MockProxy<PrismaService>;
  let jwt: JwtService;
  const apple = {
    getVerifiedTransaction: jest.fn(),
    verifyTransaction: jest.fn(),
    verifyNotification: jest.fn(),
  };
  const google = { getProductPurchase: jest.fn(), consume: jest.fn(), packageName: 'com.test.app' };
  const pubsub = { verify: jest.fn() };
  const mock = (fn: unknown) => fn as unknown as jest.Mock;

  beforeAll(async () => {
    prisma = mockDeep<PrismaService>();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(AppleStoreClient)
      .useValue(apple)
      .overrideProvider(GooglePlayClient)
      .useValue(google)
      .overrideProvider(PubSubPushVerifier)
      .useValue(pubsub)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mock(prisma.user.findUnique).mockResolvedValue({ id: USER_ID });
    mock(prisma.user.findUniqueOrThrow).mockResolvedValue({ gems: 220, coins: 15 });
    mock(prisma.$transaction).mockImplementation(async (cb: unknown) =>
      (cb as (c: unknown) => unknown)(prisma),
    );
    mock(prisma.gemPackDefinition.findUnique).mockImplementation(
      async ({
        where,
      }: {
        where: { platform_productId: { platform: IapPlatform; productId: string } };
      }) =>
        PACKS.find(
          (p) =>
            p.platform === where.platform_productId.platform &&
            p.productId === where.platform_productId.productId,
        ) ?? null,
    );
    mock(prisma.iapPurchase.create).mockResolvedValue({});
    mock(prisma.user.update).mockResolvedValue({});
    pubsub.verify.mockResolvedValue(undefined);
    google.consume.mockResolvedValue(undefined);
  });

  function bearer(): string {
    return `Bearer ${jwt.sign({ sub: USER_ID }, { expiresIn: '1h' } as never)}`;
  }

  describe('POST /iap/apple/verify', () => {
    it('returns 401 without a bearer token', async () => {
      await request(app.getHttpServer())
        .post('/iap/apple/verify')
        .send({ transactionId: '1' })
        .expect(401);
    });

    it('returns 400 for an invalid body', async () => {
      await request(app.getHttpServer())
        .post('/iap/apple/verify')
        .set('Authorization', bearer())
        .send({ transactionId: '', gems: 9999 })
        .expect(400);
    });

    it('credits gems and returns the authoritative balance', async () => {
      apple.getVerifiedTransaction.mockResolvedValue({
        transaction: appleTx(),
        environment: IapEnvironment.SANDBOX,
      });

      const res = await request(app.getHttpServer())
        .post('/iap/apple/verify')
        .set('Authorization', bearer())
        .send({ transactionId: '2000000999' })
        .expect(200);

      expect(res.body).toEqual({
        status: 'granted',
        productId: APPLE_PRODUCT,
        gemsGranted: 220,
        gems: 220,
        coins: 15,
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { gems: { increment: 220 } },
      });
    });

    it('returns duplicate without crediting twice', async () => {
      apple.getVerifiedTransaction.mockResolvedValue({
        transaction: appleTx(),
        environment: IapEnvironment.SANDBOX,
      });
      mock(prisma.$transaction).mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
      );
      mock(prisma.iapPurchase.findUnique).mockResolvedValue({
        userId: USER_ID,
        status: IapPurchaseStatus.GRANTED,
      });

      const res = await request(app.getHttpServer())
        .post('/iap/apple/verify')
        .set('Authorization', bearer())
        .send({ transactionId: '2000000999' })
        .expect(200);

      expect(res.body.status).toBe('duplicate');
      expect(res.body.gemsGranted).toBe(0);
    });

    it('returns 403 when the purchase belongs to another playerId', async () => {
      apple.getVerifiedTransaction.mockResolvedValue({
        transaction: appleTx({ appAccountToken: OTHER_USER }),
        environment: IapEnvironment.PRODUCTION,
      });

      await request(app.getHttpServer())
        .post('/iap/apple/verify')
        .set('Authorization', bearer())
        .send({ transactionId: '2000000999' })
        .expect(403);
    });

    it('returns 409 when another account already claimed it', async () => {
      apple.getVerifiedTransaction.mockResolvedValue({
        transaction: appleTx(),
        environment: IapEnvironment.PRODUCTION,
      });
      mock(prisma.$transaction).mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
      );
      mock(prisma.iapPurchase.findUnique).mockResolvedValue({
        userId: OTHER_USER,
        status: IapPurchaseStatus.GRANTED,
      });

      await request(app.getHttpServer())
        .post('/iap/apple/verify')
        .set('Authorization', bearer())
        .send({ transactionId: '2000000999' })
        .expect(409);
    });
  });

  describe('POST /iap/google/verify', () => {
    it('credits gems, consumes the purchase, and returns 200', async () => {
      google.getProductPurchase.mockResolvedValue({
        purchaseState: 0,
        consumptionState: 0,
        obfuscatedExternalAccountId: USER_ID,
        orderId: 'GPA.1',
      });

      const res = await request(app.getHttpServer())
        .post('/iap/google/verify')
        .set('Authorization', bearer())
        .send({ productId: GOOGLE_PRODUCT, purchaseToken: TOKEN })
        .expect(200);

      expect(res.body).toMatchObject({ status: 'granted', gemsGranted: 1390 });
      expect(google.consume).toHaveBeenCalledWith(GOOGLE_PRODUCT, TOKEN);
    });

    it('returns pending for an unpaid purchase', async () => {
      google.getProductPurchase.mockResolvedValue({
        purchaseState: 2,
        obfuscatedExternalAccountId: USER_ID,
      });

      const res = await request(app.getHttpServer())
        .post('/iap/google/verify')
        .set('Authorization', bearer())
        .send({ productId: GOOGLE_PRODUCT, purchaseToken: TOKEN })
        .expect(200);

      expect(res.body.status).toBe('pending');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('returns 400 when purchaseToken is missing', async () => {
      await request(app.getHttpServer())
        .post('/iap/google/verify')
        .set('Authorization', bearer())
        .send({ productId: GOOGLE_PRODUCT })
        .expect(400);
    });
  });

  describe('POST /iap/apple/notifications/*', () => {
    it('returns 401 for an invalid signature', async () => {
      apple.verifyNotification.mockRejectedValue(new UnauthorizedException());

      await request(app.getHttpServer())
        .post('/iap/apple/notifications/production')
        .send({ signedPayload: 'bad' })
        .expect(401);
    });

    it('returns 400 without signedPayload', async () => {
      await request(app.getHttpServer())
        .post('/iap/apple/notifications/sandbox')
        .send({})
        .expect(400);
    });

    it('acks TEST notifications', async () => {
      apple.verifyNotification.mockResolvedValue({ notificationType: NotificationTypeV2.TEST });

      const res = await request(app.getHttpServer())
        .post('/iap/apple/notifications/sandbox')
        .send({ signedPayload: 'ok' })
        .expect(200);

      expect(res.body).toEqual({ status: 'ignored' });
      expect(apple.verifyNotification).toHaveBeenCalledWith('ok', IapEnvironment.SANDBOX);
    });

    it('takes gems back on REFUND', async () => {
      apple.verifyNotification.mockResolvedValue({
        notificationType: NotificationTypeV2.REFUND,
        data: { signedTransactionInfo: 'tx' },
      });
      apple.verifyTransaction.mockResolvedValue(appleTx({ revocationDate: 1_700_000_100_000 }));
      mock(prisma.iapPurchase.findUnique).mockResolvedValue({
        id: 'row',
        userId: USER_ID,
        platform: IapPlatform.APPLE,
        storeTransactionId: '2000000999',
        gemsGranted: 220,
      });
      mock(prisma.iapPurchase.updateMany).mockResolvedValue({ count: 1 });

      const res = await request(app.getHttpServer())
        .post('/iap/apple/notifications/production')
        .send({ signedPayload: 'ok' })
        .expect(200);

      expect(res.body).toEqual({ status: 'refunded' });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { gems: { decrement: 220 } },
      });
    });
  });

  describe('POST /iap/google/rtdn', () => {
    it('returns 401 when the Pub/Sub token is invalid', async () => {
      pubsub.verify.mockRejectedValue(new UnauthorizedException());

      await request(app.getHttpServer())
        .post('/iap/google/rtdn')
        .set('Authorization', 'Bearer bad')
        .send(rtdn({ packageName: 'com.test.app' }))
        .expect(401);
    });

    it('acks a test notification with 204', async () => {
      await request(app.getHttpServer())
        .post('/iap/google/rtdn')
        .set('Authorization', 'Bearer good')
        .send(rtdn({ packageName: 'com.test.app', testNotification: { version: '1.0' } }))
        .expect(204);

      expect(pubsub.verify).toHaveBeenCalledWith('Bearer good');
    });

    it('takes gems back on a voided purchase', async () => {
      mock(prisma.iapPurchase.findUnique).mockResolvedValue({
        id: 'row',
        userId: USER_ID,
        platform: IapPlatform.GOOGLE,
        storeTransactionId: TOKEN,
        gemsGranted: 1390,
      });
      mock(prisma.iapPurchase.updateMany).mockResolvedValue({ count: 1 });

      await request(app.getHttpServer())
        .post('/iap/google/rtdn')
        .set('Authorization', 'Bearer good')
        .send(
          rtdn({
            packageName: 'com.test.app',
            voidedPurchaseNotification: { purchaseToken: TOKEN, orderId: 'GPA.1', productType: 2 },
          }),
        )
        .expect(204);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { gems: { decrement: 1390 } },
      });
    });
  });

  it('throttles /iap/apple/verify (429)', async () => {
    apple.getVerifiedTransaction.mockResolvedValue({
      transaction: appleTx(),
      environment: IapEnvironment.SANDBOX,
    });
    let saw429 = false;
    for (let i = 0; i < 25 && !saw429; i += 1) {
      const res = await request(app.getHttpServer())
        .post('/iap/apple/verify')
        .set('Authorization', bearer())
        .send({ transactionId: '2000000999' });
      saw429 = res.status === 429;
    }
    expect(saw429).toBe(true);
  });
});
