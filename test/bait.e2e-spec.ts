import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { AdmobSsvVerifier } from '../src/modules/rewards/admob-ssv.verifier';

describe('Bait economy with PostgreSQL', () => {
  let app: INestApplication;
  let db: PrismaService;
  let id: string;
  let auth: string;
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL');
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.JWT_SECRET = randomUUID();
    const { bootstrap } = await import('../src/main');
    app = (await bootstrap()).app;
    db = app.get(PrismaService);
    id = (
      await db.user.create({
        data: { name: 'Bait test', provider: 'GOOGLE_PLAY', providerUserId: randomUUID(), gems: 1 },
      })
    ).id;
    auth = 'Bearer ' + app.get(JwtService).sign({ sub: id });
    jest.spyOn(app.get(AdmobSsvVerifier), 'verify').mockResolvedValue(undefined);
  });
  afterAll(async () => {
    if (id) await db.user.delete({ where: { id } });
    jest.restoreAllMocks();
    await app?.close();
  });
  const post = (path: string, data: object) =>
    request(app.getHttpServer())
      .post('/pier/' + path)
      .set('Authorization', auth)
      .send(data);
  const state = async () =>
    (await request(app.getHttpServer()).get('/pier/state').set('Authorization', auth).expect(200))
      .body;
  it('charges one gem once, even on concurrent retries, and preserves bonus bait at midnight', async () => {
    const key = randomUUID();
    await Promise.all([
      post('bait/purchase', { key }).expect(201),
      post('bait/purchase', { key }).expect(201),
    ]);
    await post('bait/purchase', { key: randomUUID() }).expect(409);
    expect(await state()).toMatchObject({ gems: 0, bait: 15 });
    await db.pierSave.update({
      where: { playerId: id },
      data: { day: new Date('2020-01-01'), bait: 0 },
    });
    expect(await state()).toMatchObject({ bait: 15, bonusBait: 3 });
  });
  it('offers every fifth catch and lets three verified views credit bait across retries', async () => {
    await state();
    await post('bait/ad', { key: randomUUID(), milestone: 5 }).expect(409);
    for (let count = 1; count <= 20; count++) {
      await db.pierCatch.create({
        data: {
          playerId: id,
          revision: count,
          species: 0,
          length: 12,
          grams: 20,
          size: 'S',
          rare: false,
        },
      });
      if (count % 5 || count === 20) continue;
      const key = randomUUID();
      const offer = () =>
        request(app.getHttpServer()).get('/pier/bait/offer').set('Authorization', auth);
      expect((await offer()).body.milestone).toBe(count);
      await post('bait/ad', { key, milestone: count }).expect(201);
      expect((await offer()).body.milestone).toBe(0);
      await post('bait/ad', { key: randomUUID(), milestone: count }).expect(409);
      const callback = (ticket: string, user: string) =>
        request(app.getHttpServer())
          .get('/rewards/admob/ssv')
          .query({
            ad_unit: '2697891384',
            custom_data: ticket,
            user_id: user,
            transaction_id: 'view-' + key,
          })
          .expect(200);
      expect((await callback(key, randomUUID())).body.status).toBe('unknown_ticket');
      expect((await callback(randomUUID(), id)).body.status).toBe('unknown_ticket');
      const receipts = await Promise.all([callback(key, id), callback(key, id)]);
      expect(receipts.map((x) => x.body.status).sort()).toEqual(['duplicate', 'granted']);
    }
    await post('bait/ad', { key: randomUUID(), milestone: 20 }).expect(409);
    expect(await state()).toMatchObject({ bait: 24, adSlots: 0 });
    await db.baitOperation.updateMany({
      where: { playerId: id, kind: 'ad' },
      data: { day: new Date('2020-01-01') },
    });
    await post('bait/ad', { key: randomUUID(), milestone: 20 }).expect(201);
    await db.pierSave.update({ where: { playerId: id }, data: { bait: 0 } });
    expect((await post('cast', { key: randomUUID(), station: 0 }).expect(201)).body.bait).toBe(11);
  });
  it('counts guest views per installation across sessions and releases only the signed receipt', async () => {
    const install = 'Installation ' + randomBytes(32).toString('hex');
    const other = 'Installation ' + randomBytes(32).toString('hex');
    const enroll = (key: string, session: string, milestone: number) =>
      request(app.getHttpServer())
        .post('/rewards/guest/ad')
        .set('Authorization', install)
        .send({ key, session, milestone });
    const available = (token: string) =>
      request(app.getHttpServer()).get('/rewards/guest/availability').set('Authorization', token);
    const check = (token: string, key: string) =>
      request(app.getHttpServer())
        .post('/rewards/guest/status')
        .set('Authorization', token)
        .send({ key });
    await available('invalid').expect(401);
    const session = randomUUID(),
      key = randomUUID();
    const offer = () =>
      request(app.getHttpServer()).get('/rewards/guest/offer/' + session + '/5').set('Authorization', install);
    expect((await offer()).body.milestone).toBe(5);
    await enroll(key, session, 5).expect(201);
    expect((await offer()).body.milestone).toBe(0);
    await enroll(key, session, 5).expect(201);
    await enroll(randomUUID(), session, 5).expect(409);
    expect((await check(install, key)).body.granted).toBe(false);
    const notify = () =>
      request(app.getHttpServer())
        .get('/rewards/admob/ssv')
        .query({
          ad_unit: '2697891384',
          custom_data: 'guest.' + key,
          user_id: key,
          transaction_id: 'guest-' + key,
        });
    const results = await Promise.all([notify(), notify()]);
    expect(results.map((x) => x.body.status).sort()).toEqual(['duplicate', 'granted']);
    expect((await check(install, key)).body.granted).toBe(true);
    expect((await check(other, key)).body.granted).toBe(false);
    const slots = await Promise.all(
      Array.from({ length: 3 }, () => enroll(randomUUID(), randomUUID(), 5)),
    );
    expect(slots.map((x) => x.status).sort()).toEqual([201, 201, 409]);
    expect((await available(install)).body.slots).toBe(0);
    expect((await available(other)).body.slots).toBe(3);
    const keys = [key, ...slots.filter((x) => x.status === 201).map((x) => x.body.ticket)];
    await db.baitOperation.deleteMany({ where: { id: { in: keys } } });
  });
});
