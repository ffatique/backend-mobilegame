import './setup-env';

import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mockDeep, MockProxy } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { AdmobSsvVerifier } from '../src/modules/rewards/admob-ssv.verifier';

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('GET /rewards/admob/ssv (e2e)', () => {
  let app: INestApplication;
  let prisma: MockProxy<PrismaService>;
  const verifier = { verify: jest.fn() };

  const callback = {
    ad_network: '1953547073528090325',
    ad_unit: '2747237135',
    reward_amount: '5',
    reward_item: 'coins',
    timestamp: '1700000000000',
    transaction_id: '18fa792de1bca816048293fc71035638',
    user_id: USER_ID,
    signature: 'ME_UCIQ_signature',
    key_id: '1916455855',
  };

  beforeAll(async () => {
    prisma = mockDeep<PrismaService>();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(AdmobSsvVerifier)
      .useValue(verifier)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    verifier.verify.mockResolvedValue(undefined);
  });

  it('grants coins and returns 200 for a verified callback', async () => {
    (prisma.user.findUnique as unknown as jest.Mock).mockResolvedValue({ id: USER_ID });
    (prisma.$transaction as unknown as jest.Mock).mockResolvedValue([]);

    const res = await request(app.getHttpServer())
      .get('/rewards/admob/ssv')
      .query(callback)
      .expect(200);

    expect(res.body).toEqual({ status: 'granted' });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { coins: { increment: 5 } },
    });
  });

  it('returns 200 without double-crediting a replayed transaction_id', async () => {
    (prisma.user.findUnique as unknown as jest.Mock).mockResolvedValue({ id: USER_ID });
    (prisma.$transaction as unknown as jest.Mock).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
    );

    const res = await request(app.getHttpServer())
      .get('/rewards/admob/ssv')
      .query(callback)
      .expect(200);

    expect(res.body).toEqual({ status: 'duplicate' });
  });

  it('returns 200 (skipped) for an unknown user', async () => {
    (prisma.user.findUnique as unknown as jest.Mock).mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .get('/rewards/admob/ssv')
      .query(callback)
      .expect(200);

    expect(res.body).toEqual({ status: 'unknown_user' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 401 when the signature is invalid', async () => {
    verifier.verify.mockRejectedValueOnce(new UnauthorizedException('bad sig'));

    await request(app.getHttpServer()).get('/rewards/admob/ssv').query(callback).expect(401);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
