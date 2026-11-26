import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { GooglePlayGamesVerifier } from '../src/modules/auth/providers/google-play-games.verifier';
import { AppleGameCenterVerifier } from '../src/modules/auth/providers/apple-gamecenter.verifier';
import { PrismaService } from '../src/modules/prisma/prisma.service';

describe('Player API with PostgreSQL', () => {
  const providerId = randomUUID();
  let app: INestApplication;
  let db: PrismaService;
  let id: string;
  let bearer: string;
  let refresh: string;

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error('Set TEST_DATABASE_URL to a migrated test database');
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.JWT_SECRET = randomUUID();
    jest.spyOn(GooglePlayGamesVerifier.prototype, 'verify').mockResolvedValue({
      provider: 'GOOGLE_PLAY',
      providerUserId: providerId,
    });
    jest.spyOn(AppleGameCenterVerifier.prototype, 'verify').mockResolvedValue({
      provider: 'APPLE_GAMECENTER',
      providerUserId: providerId,
    });
    const { bootstrap } = await import('../src/main');
    app = (await bootstrap()).app;
    db = app.get(PrismaService);
  });

  afterAll(async () => {
    try {
      await db?.user.deleteMany({ where: { providerUserId: providerId } });
    } finally {
      await app?.close();
      jest.restoreAllMocks();
    }
  });

  it('opens one account for simultaneous logins and keeps providers separate', async () => {
    const login = () =>
      request(app.getHttpServer())
        .post('/users/google')
        .send({ authToken: 'mock-code', name: 'Ana' })
        .expect(200);
    const [first, second] = await Promise.all([login(), login()]);
    id = first.body.playerId;
    expect(second.body.playerId).toBe(id);
    bearer = 'Bearer ' + first.body.accessToken;
    refresh = first.body.refreshToken;
    const apple = await request(app.getHttpServer())
      .post('/users/apple')
      .send({
        publicKeyUrl: 'https://static.gc.apple.com/public-key/mock.cer',
        signature: 'mock-signature',
        salt: 'mock',
        timestamp: Date.now(),
        playerId: providerId,
      })
      .expect(200);
    expect(apple.body.playerId).not.toBe(id);
  });

  it('protects player routes and starts a new player with zero coins', async () => {
    const api = request(app.getHttpServer());
    await api.get('/health').expect(200);
    await api.get('/users/me').expect(401);
    await api.post('/shop/buy').send({ itemId: 'large_basket' }).expect(401);
    const me = await api.get('/users/me').set('Authorization', bearer).expect(200);
    expect(me.body).toMatchObject({ id, name: 'Ana', coins: 0, ownedItemIds: [] });
    const shop = await api.get('/shop').set('Authorization', bearer).expect(200);
    expect(shop.body).toHaveLength(5);
  });

  it('rolls back unaffordable purchases and charges a concurrent purchase only once', async () => {
    const buy = (itemId: string) =>
      request(app.getHttpServer()).post('/shop/buy').set('Authorization', bearer).send({ itemId });
    await buy('unknown').expect(404);
    await buy('large_basket').expect(400);
    await db.user.update({ where: { id }, data: { coins: 125 } });
    await buy('point_extension').expect(409);
    const results = await Promise.all([buy('rocks_walkway'), buy('rocks_walkway')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    await buy('point_extension').expect(200);
    await buy('long_rod').expect(409);
    const me = await request(app.getHttpServer()).get('/users/me').set('Authorization', bearer);
    expect(me.body).toMatchObject({ coins: 0, ownedItemIds: ['point_extension', 'rocks_walkway'] });
  });

  it('rotates the session and revokes it on logout', async () => {
    const api = request(app.getHttpServer());
    const rotated = await api.post('/auth/refresh').send({ refreshToken: refresh }).expect(200);
    await api
      .post('/auth/logout')
      .set('Authorization', 'Bearer ' + rotated.body.accessToken)
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(204);
    await api.post('/auth/refresh').send({ refreshToken: rotated.body.refreshToken }).expect(401);
  });
});
