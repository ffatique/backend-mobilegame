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
      displayName: 'Ana',
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
      await db?.user.deleteMany({ where: { providerUserId: { startsWith: providerId } } });
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

  it('shares accepted friendships, limits search fields, and rejects duplicate or unauthorized requests', async () => {
    const api = request(app.getHttpServer());
    const login = async (suffix: string) => {
      jest.spyOn(GooglePlayGamesVerifier.prototype, 'verify').mockResolvedValueOnce({
        provider: 'GOOGLE_PLAY',
        providerUserId: providerId + suffix,
        displayName: 'Ana',
        avatar: 'https://example.com/portrait.png',
      });
      return (await api.post('/users/google').send({ authToken: 'other-code' }).expect(200)).body;
    };
    const other = await login('b'),
      outsider = await login('c');
    const action = (token: string, target: string, act: string) =>
      api
        .post('/pier/friends/' + target)
        .set('Authorization', token)
        .send({ action: act });
    const second = 'Bearer ' + other.accessToken;
    await api.get('/pier/friends').expect(401);
    const results = await api.get('/pier/players?q=Ana').set('Authorization', bearer).expect(200);
    expect(results.body.items).toEqual(
      expect.arrayContaining([
        { id: other.playerId, name: 'Ana', avatar: 'https://example.com/portrait.png' },
      ]),
    );
    expect(
      results.body.items.every((r: object) => Object.keys(r).sort().join(',') === 'avatar,id,name'),
    ).toBe(true);
    await action(bearer, id, 'send').expect(400);
    await action(bearer, other.playerId, 'send').expect(201);
    await action(second, id, 'send').expect(409);
    await action('Bearer ' + outsider.accessToken, id, 'accept').expect(404);
    await action(bearer, other.playerId, 'accept').expect(404);
    await action(second, id, 'decline').expect(201);
    await action(bearer, other.playerId, 'send').expect(201);
    await action(second, id, 'accept').expect(201);
    for (const [token, peer] of [
      [bearer, other.playerId],
      [second, id],
    ]) {
      const list = await api.get('/pier/friends').set('Authorization', token).expect(200);
      expect(list.body.items).toEqual([expect.objectContaining({ id: peer, status: 'friend' })]);
    }
  });

  it('restores progress once and charges one cast across concurrent UTC refills', async () => {
    const api = request(app.getHttpServer());
    const state = () => api.get('/pier/state').set('Authorization', bearer).expect(200);
    const initial = await state();
    expect(initial.body).toMatchObject({ bait: 12, revision: 0, snapshot: '' });
    const payload = {
      revision: 0,
      mutation: randomUUID(),
      snapshot: 'test-save',
      spend: 1,
      capture: { species: 3, rare: true, length: 56, grams: 805, size: 'L' },
    };
    const save = (body: object) => api.post('/pier/state').set('Authorization', bearer).send(body);
    await Promise.all([save(payload).expect(201), save(payload).expect(201)]);
    expect((await state()).body).toMatchObject({ bait: 11, revision: 1, snapshot: 'test-save' });
    await save({ ...payload, mutation: randomUUID() }).expect(409);
    await db.pierSave.update({
      where: { playerId: id },
      data: { day: new Date('2000-01-01Z'), bait: 0 },
    });
    process.env.CRON_SECRET = randomUUID();
    const cron = () =>
      api
        .get('/jobs/bait')
        .set('Authorization', 'Bearer ' + process.env.CRON_SECRET)
        .expect(200);
    await api.get('/jobs/bait').expect(401);
    await Promise.all([
      cron(),
      cron(),
      state(),
      save({ revision: 1, mutation: randomUUID(), snapshot: 'second-save', spend: 1 }).expect(201),
    ]);
    expect((await state()).body).toMatchObject({ bait: 11, revision: 2, snapshot: 'second-save' });
    const history = await api.get('/pier/history').set('Authorization', bearer).expect(200);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0]).toMatchObject(payload.capture);
    const stats = await api.get('/pier/stats').set('Authorization', bearer).expect(200);
    expect(stats.body).toEqual({ total: 1, species: 1, largest: 56, kind: 3 });
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
