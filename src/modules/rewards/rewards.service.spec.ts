import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { mockDeep, MockProxy } from 'jest-mock-extended';
import { PrismaService } from '../prisma/prisma.service';
import { AdmobSsvVerifier } from './admob-ssv.verifier';
import { REWARD_COINS, RewardsService } from './rewards.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const VALID_QUERY =
  `user_id=${USER_ID}&transaction_id=txn-123&reward_amount=5&reward_item=coins` +
  '&ad_unit=au-1&ad_network=an-1&timestamp=1700000000000';

describe('RewardsService', () => {
  let prisma: MockProxy<PrismaService>;
  let verifier: { verify: jest.Mock };
  let service: RewardsService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    verifier = { verify: jest.fn().mockResolvedValue(undefined) };
    service = new RewardsService(
      prisma as unknown as PrismaService,
      verifier as unknown as AdmobSsvVerifier,
      new ConfigService({ ADMOB_REWARDED_AD_UNITS: ['au-1'] }),
    );
  });

  it('grants coins for a valid callback and records the transaction', async () => {
    (prisma.user.findUnique as unknown as jest.Mock).mockResolvedValue({ id: USER_ID });
    (prisma.$transaction as unknown as jest.Mock).mockResolvedValue([]);

    const out = await service.grantFromSsv(VALID_QUERY);

    expect(out.status).toBe('granted');
    expect(verifier.verify).toHaveBeenCalledWith(VALID_QUERY);
    expect(prisma.adRewardGrant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: USER_ID,
        transactionId: 'txn-123',
        coinsGranted: REWARD_COINS,
        rewardAmount: 5,
        rewardItem: 'coins',
      }),
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { coins: { increment: REWARD_COINS } },
    });
  });

  it('is idempotent when the transaction_id was already granted', async () => {
    (prisma.user.findUnique as unknown as jest.Mock).mockResolvedValue({ id: USER_ID });
    (prisma.$transaction as unknown as jest.Mock).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    const out = await service.grantFromSsv(VALID_QUERY);

    expect(out.status).toBe('duplicate');
  });

  it('skips granting when the user does not exist', async () => {
    (prisma.user.findUnique as unknown as jest.Mock).mockResolvedValue(null);

    const out = await service.grantFromSsv(VALID_QUERY);

    expect(out.status).toBe('unknown_user');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('skips when user_id is not a valid UUID', async () => {
    const out = await service.grantFromSsv(
      'ad_unit=au-1&user_id=not-a-uuid&transaction_id=txn-9&timestamp=1700000000000',
    );

    expect(out.status).toBe('unknown_user');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('skips a different game ad unit', async () => {
    expect(await service.grantFromSsv(VALID_QUERY.replace('au-1', 'other'))).toEqual({
      status: 'unknown_ad_unit',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('propagates the verifier failure for an invalid signature', async () => {
    verifier.verify.mockRejectedValueOnce(new UnauthorizedException('bad sig'));

    await expect(service.grantFromSsv(VALID_QUERY)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rethrows unexpected database errors', async () => {
    (prisma.user.findUnique as unknown as jest.Mock).mockResolvedValue({ id: USER_ID });
    (prisma.$transaction as unknown as jest.Mock).mockRejectedValue(new Error('db down'));

    await expect(service.grantFromSsv(VALID_QUERY)).rejects.toThrow('db down');
  });
});
