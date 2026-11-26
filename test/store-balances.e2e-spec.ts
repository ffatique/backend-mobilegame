import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { NotificationTypeV2, Type } from '@apple/app-store-server-library';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import request from 'supertest';
import { AppleStoreClient } from '../src/modules/iap/apple/apple-store.client';
import { GooglePlayClient } from '../src/modules/iap/google/google-play.client';
import { PubSubPushVerifier } from '../src/modules/iap/google/pubsub-push.verifier';
import { PrismaService } from '../src/modules/prisma/prisma.service';

describe('Store event balances in PostgreSQL', () => {
  const productId = 'test.' + randomUUID();
  const appleTransaction = randomUUID();
  const googleToken = randomUUID();
  let app: INestApplication;
  let db: PrismaService;
  let playerId: string;
  let bearer: string;

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL');
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.JWT_SECRET = randomUUID();
    process.env.ADMOB_REWARDED_AD_UNITS = '123456789';
    process.env.GOOGLE_PLAY_PACKAGE_NAME = 'com.test.pier';
    const { bootstrap } = await import('../src/main');
    app = (await bootstrap()).app;
    db = app.get(PrismaService);
    const user = await db.user.create({
      data: { provider: 'GOOGLE_PLAY', providerUserId: randomUUID(), name: 'Fixture' },
    });
    playerId = user.id;
    bearer = 'Bearer ' + app.get(JwtService).sign({ sub: playerId });
    await db.gemPackDefinition.createMany({
      data: [
        { platform: 'APPLE', productId, gems: 40 },
        { platform: 'GOOGLE', productId, gems: 40 },
      ],
    });
  });

  afterAll(async () => {
    try {
      if (db) {
        await db.iapPurchase.deleteMany({
          where: { storeTransactionId: { in: [googleToken, appleTransaction] } },
        });
        await db.gemPackDefinition.deleteMany({ where: { productId } });
        if (playerId) await db.user.delete({ where: { id: playerId } });
      }
    } finally {
      jest.restoreAllMocks();
      await app?.close();
    }
  });

  it('credits once for concurrent Apple deliveries and preserves the newer refund reversal', async () => {
    const apple = app.get(AppleStoreClient);
    jest.spyOn(apple, 'verifyTransaction').mockResolvedValue({
      type: Type.CONSUMABLE,
      productId,
      transactionId: appleTransaction,
      appAccountToken: playerId,
    });
    const events: Record<string, [NotificationTypeV2, number]> = {
      buy: [NotificationTypeV2.ONE_TIME_CHARGE, 1000],
      refund: [NotificationTypeV2.REFUND, 2000],
      restore: [NotificationTypeV2.REFUND_REVERSED, 3000],
    };
    jest.spyOn(apple, 'verifyNotification').mockImplementation(async (event) => ({
      notificationType: events[event][0],
      signedDate: events[event][1],
      data: { signedTransactionInfo: 'signed' },
    }));
    const send = (event: string) =>
      request(app.getHttpServer())
        .post('/iap/apple/notifications/production')
        .send({ signedPayload: event })
        .expect(200);
    const results = await Promise.all([send('buy'), send('buy')]);
    expect(results.map((r) => r.body.status).sort()).toEqual(['duplicate', 'granted']);
    expect((await send('refund')).body.status).toBe('refunded');
    expect((await send('restore')).body.status).toBe('reversed');
    expect((await send('refund')).body.status).toBe('duplicate');
    expect((await db.user.findUniqueOrThrow({ where: { id: playerId } })).gems).toBe(40);
  });

  it('retains a Google void that arrives before the client verifies the purchase', async () => {
    jest.spyOn(app.get(PubSubPushVerifier), 'verify').mockResolvedValue();
    const google = app.get(GooglePlayClient);
    jest.spyOn(google, 'getProductPurchase').mockResolvedValue({
      obfuscatedExternalAccountId: playerId,
      purchaseState: 0,
      consumptionState: 0,
    });
    const consume = jest.spyOn(google, 'consume').mockResolvedValue();
    const data = Buffer.from(
      JSON.stringify({
        packageName: 'com.test.pier',
        voidedPurchaseNotification: { purchaseToken: googleToken, productType: 2 },
      }),
    ).toString('base64');
    await request(app.getHttpServer())
      .post('/iap/google/rtdn')
      .send({ message: { data } })
      .expect(204);
    const result = await request(app.getHttpServer())
      .post('/iap/google/verify')
      .set('Authorization', bearer)
      .send({ productId, purchaseToken: googleToken })
      .expect(200);
    expect(result.body).toMatchObject({ status: 'refunded', gemsGranted: 0 });
    expect(consume).not.toHaveBeenCalled();
  });

  it('credits one signed AdMob impression only once', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    jest.spyOn(global, 'fetch').mockResolvedValue(Response.json({ keys: [{ keyId: 1, pem }] }));
    const raw = 'ad_unit=123456789&transaction_id=' + randomUUID() + '&user_id=' + playerId;
    const signature = sign('sha256', Buffer.from(raw), privateKey).toString('base64url');
    const path = '/rewards/admob/ssv?' + raw + '&signature=' + signature + '&key_id=1';
    const results = await Promise.all(
      [1, 2].map(() => request(app.getHttpServer()).get(path).expect(200)),
    );
    expect(results.map((r) => r.body.status).sort()).toEqual(['duplicate', 'granted']);
    expect((await db.user.findUniqueOrThrow({ where: { id: playerId } })).coins).toBe(5);
  });
});
