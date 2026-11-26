import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { mockDeep, type DeepMockProxy } from 'jest-mock-extended';
import { PrismaService } from '../prisma/prisma.service';
import { RefreshTokensService } from './refresh-tokens.service';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

describe('RefreshTokensService', () => {
  let prisma: DeepMockProxy<PrismaService>;
  let config: ConfigService;
  let svc: RefreshTokensService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    config = { get: jest.fn().mockReturnValue(60) } as unknown as ConfigService;
    svc = new RefreshTokensService(prisma, config);
  });

  it('issues a brand-new token with a fresh family and persists only its hash', async () => {
    (prisma.refreshToken.create as unknown as jest.Mock).mockResolvedValue({});

    const result = await svc.issue('user-1', { deviceId: 'dev-1', userAgent: 'ua' });

    expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
    const args = (prisma.refreshToken.create as unknown as jest.Mock).mock.calls[0][0];
    expect(args.data.userId).toBe('user-1');
    expect(args.data.tokenHash).toBe(sha256(result.refreshToken));
    expect(args.data.tokenHash).toHaveLength(64);
    expect(args.data.familyId).toBe(result.familyId);
    expect(args.data.deviceId).toBe('dev-1');
    expect(result.expiresIn).toBe(60 * 86_400);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rotates a valid token: issues a replacement and revokes the old row', async () => {
    const raw = 'old-raw-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const tokenHash = sha256(raw);
    (prisma.refreshToken.findUnique as unknown as jest.Mock).mockResolvedValue({
      id: 'tok-1',
      userId: 'user-1',
      familyId: 'fam-1',
      tokenHash,
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: null,
      replacedById: null,
      deviceId: 'dev-1',
      userAgent: null,
      ipHash: null,
    });
    // $transaction(callback) — invoke callback with the tx mock and return its result.
    (prisma.$transaction as unknown as jest.Mock).mockImplementation(
      async (cb: (tx: PrismaService) => Promise<unknown>) => cb(prisma),
    );
    (prisma.refreshToken.create as unknown as jest.Mock).mockResolvedValue({ id: 'tok-2' });
    (prisma.refreshToken.updateMany as unknown as jest.Mock).mockResolvedValue({ count: 1 });

    const { userId, issued } = await svc.rotate(raw);

    expect(userId).toBe('user-1');
    expect(issued.familyId).toBe('fam-1');
    expect(issued.refreshToken).not.toBe(raw);
    const createArgs = (prisma.refreshToken.create as unknown as jest.Mock).mock.calls[0][0];
    expect(createArgs.data.tokenHash).toBe(sha256(issued.refreshToken));
    const updateArgs = (prisma.refreshToken.updateMany as unknown as jest.Mock).mock.calls[0][0];
    expect(updateArgs.where).toMatchObject({ id: 'tok-1', revokedAt: null, replacedById: null });
    expect(updateArgs.data.replacedById).toBe('tok-2');
  });

  it('throws Unauthorized when the token is unknown', async () => {
    (prisma.refreshToken.findUnique as unknown as jest.Mock).mockResolvedValue(null);
    await expect(svc.rotate('whatever')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('detects reuse and revokes the entire family when an already-rotated token is presented', async () => {
    const raw = 'replayed-token';
    (prisma.refreshToken.findUnique as unknown as jest.Mock).mockResolvedValue({
      id: 'tok-1',
      userId: 'user-1',
      familyId: 'fam-evil',
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: null,
      replacedById: 'tok-2', // already replaced
      deviceId: null,
      userAgent: null,
      ipHash: null,
    });
    (prisma.refreshToken.updateMany as unknown as jest.Mock).mockResolvedValue({ count: 3 });

    await expect(svc.rotate(raw)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'fam-evil', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('rejects an expired token', async () => {
    const raw = 'expired-token';
    (prisma.refreshToken.findUnique as unknown as jest.Mock).mockResolvedValue({
      id: 'tok-1',
      userId: 'user-1',
      familyId: 'fam-1',
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() - 1000),
      revokedAt: null,
      replacedById: null,
      deviceId: null,
      userAgent: null,
      ipHash: null,
    });

    await expect(svc.rotate(raw)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('revokeAllForUser revokes only still-active tokens', async () => {
    (prisma.refreshToken.updateMany as unknown as jest.Mock).mockResolvedValue({ count: 2 });
    await svc.revokeAllForUser('user-1');
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('revokeRaw revokes by hash and reports whether anything matched', async () => {
    (prisma.refreshToken.updateMany as unknown as jest.Mock).mockResolvedValueOnce({ count: 1 });
    expect(await svc.revokeRaw('user-1', 'raw')).toBe(true);
    (prisma.refreshToken.updateMany as unknown as jest.Mock).mockResolvedValueOnce({ count: 0 });
    expect(await svc.revokeRaw('user-1', 'raw')).toBe(false);
  });
});
