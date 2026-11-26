import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { AuthProviderType } from '@prisma/client';
import { AuthService } from './auth.service';
import type { ProviderVerifier } from './providers/provider-verifier.interface';
import type { RefreshTokensService } from './refresh-tokens.service';

function makeVerifier(
  provider: AuthProviderType,
  impl: ProviderVerifier['verify'],
): ProviderVerifier {
  return { provider, verify: impl };
}

describe('AuthService', () => {
  const jwt = { sign: jest.fn() } as unknown as JwtService;
  const config = { get: jest.fn() } as unknown as ConfigService;
  const refreshTokens = {
    issue: jest.fn(),
    rotate: jest.fn(),
  } as unknown as RefreshTokensService;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('verifies a Google Play Games token via the matching verifier', async () => {
    const gpg = makeVerifier(
      AuthProviderType.GOOGLE_PLAY,
      jest.fn().mockResolvedValue({
        provider: AuthProviderType.GOOGLE_PLAY,
        providerUserId: 'g-123',
        displayName: 'Player1',
      }),
    );
    const apple = makeVerifier(AuthProviderType.APPLE_GAMECENTER, jest.fn());

    const svc = new AuthService(jwt, config, refreshTokens, gpg as never, apple as never);
    const result = await svc.verifyProviderToken(AuthProviderType.GOOGLE_PLAY, 'tok');

    expect(gpg.verify).toHaveBeenCalledWith('tok');
    expect(apple.verify).not.toHaveBeenCalled();
    expect(result.providerUserId).toBe('g-123');
  });

  it('throws Unauthorized for an unsupported provider', async () => {
    const gpg = makeVerifier(AuthProviderType.GOOGLE_PLAY, jest.fn());
    const apple = makeVerifier(AuthProviderType.APPLE_GAMECENTER, jest.fn());
    const svc = new AuthService(jwt, config, refreshTokens, gpg as never, apple as never);

    await expect(
      svc.verifyProviderToken('UNKNOWN' as AuthProviderType, 't'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('issues a signed access token using configured expiration', () => {
    (config.get as jest.Mock).mockReturnValue('2h');
    (jwt.sign as jest.Mock).mockReturnValue('signed.jwt.value');
    const gpg = makeVerifier(AuthProviderType.GOOGLE_PLAY, jest.fn());
    const apple = makeVerifier(AuthProviderType.APPLE_GAMECENTER, jest.fn());
    const svc = new AuthService(jwt, config, refreshTokens, gpg as never, apple as never);

    const out = svc.issueAccessToken('player-abc');

    expect(jwt.sign).toHaveBeenCalledWith({ sub: 'player-abc' }, { expiresIn: '2h' });
    expect(out).toEqual({ accessToken: 'signed.jwt.value', expiresIn: '2h' });
  });

  it('issues a token pair (access + refresh) on sign-in', async () => {
    (config.get as jest.Mock).mockReturnValue('1h');
    (jwt.sign as jest.Mock).mockReturnValue('access.jwt');
    const expiresAt = new Date(Date.now() + 60 * 86_400_000);
    (refreshTokens.issue as jest.Mock).mockResolvedValue({
      refreshToken: 'raw-refresh',
      tokenHash: 'hash',
      familyId: 'fam-1',
      expiresAt,
      expiresIn: 60 * 86_400,
    });
    const gpg = makeVerifier(AuthProviderType.GOOGLE_PLAY, jest.fn());
    const apple = makeVerifier(AuthProviderType.APPLE_GAMECENTER, jest.fn());
    const svc = new AuthService(jwt, config, refreshTokens, gpg as never, apple as never);

    const pair = await svc.issueTokenPair('player-1', { deviceId: 'dev-1' });

    expect(refreshTokens.issue).toHaveBeenCalledWith('player-1', { deviceId: 'dev-1' });
    expect(pair).toEqual({
      accessToken: 'access.jwt',
      expiresIn: '1h',
      refreshToken: 'raw-refresh',
      refreshExpiresAt: expiresAt,
      refreshExpiresIn: 60 * 86_400,
    });
  });

  it('refreshTokenPair rotates and issues a fresh access token', async () => {
    (config.get as jest.Mock).mockReturnValue('1h');
    (jwt.sign as jest.Mock).mockReturnValue('new.access.jwt');
    const expiresAt = new Date(Date.now() + 60 * 86_400_000);
    (refreshTokens.rotate as jest.Mock).mockResolvedValue({
      userId: 'player-7',
      issued: {
        refreshToken: 'rotated-raw',
        tokenHash: 'h',
        familyId: 'fam-7',
        expiresAt,
        expiresIn: 60 * 86_400,
      },
    });
    const gpg = makeVerifier(AuthProviderType.GOOGLE_PLAY, jest.fn());
    const apple = makeVerifier(AuthProviderType.APPLE_GAMECENTER, jest.fn());
    const svc = new AuthService(jwt, config, refreshTokens, gpg as never, apple as never);

    const pair = await svc.refreshTokenPair('old-raw');

    expect(refreshTokens.rotate).toHaveBeenCalledWith('old-raw', {});
    expect(jwt.sign).toHaveBeenCalledWith({ sub: 'player-7' }, { expiresIn: '1h' });
    expect(pair.accessToken).toBe('new.access.jwt');
    expect(pair.refreshToken).toBe('rotated-raw');
  });
});
