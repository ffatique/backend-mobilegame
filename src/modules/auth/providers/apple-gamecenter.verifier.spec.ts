import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { AppleGameCenterVerifier } from './apple-gamecenter.verifier';

describe('AppleGameCenterVerifier', () => {
  const BUNDLE_ID = 'com.test.app';
  const PUBLIC_KEY_URL = 'https://static.gc.apple.com/public-key/gc-prod-7.cer';
  const PLAYER_ID = 'A:_player-1';

  let privateKey: KeyObject;
  let publicKeyPem: string;
  let verifier: AppleGameCenterVerifier;
  let config: ConfigService;

  beforeAll(() => {
    const { privateKey: priv, publicKey: pub } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    privateKey = priv;
    publicKeyPem = pub.export({ type: 'spki', format: 'pem' }).toString();
  });

  beforeEach(() => {
    config = {
      get: jest.fn((key: string) => (key === 'APPLE_GAMECENTER_BUNDLE_ID' ? BUNDLE_ID : undefined)),
    } as unknown as ConfigService;
    verifier = new AppleGameCenterVerifier(config);

    // Bypass the real cert download by injecting the public key into the cache.
    // The `certCache` is private; we cast to access it. This keeps the test
    // hermetic — no network call — while still exercising the signature path.
    (
      verifier as unknown as { certCache: Map<string, { expiresAt: number; publicKeyPem: string }> }
    ).certCache.set(PUBLIC_KEY_URL, { expiresAt: Date.now() + 60000, publicKeyPem });
  });

  function signPayload(opts: {
    playerId?: string;
    bundleId?: string;
    timestampMs: number;
    saltBase64: string;
  }): string {
    const playerIdBuf = Buffer.from(opts.playerId ?? PLAYER_ID, 'utf8');
    const bundleIdBuf = Buffer.from(opts.bundleId ?? BUNDLE_ID, 'utf8');
    const timestampBuf = Buffer.alloc(8);
    timestampBuf.writeBigUInt64BE(BigInt(opts.timestampMs));
    const saltBuf = Buffer.from(opts.saltBase64, 'base64');
    const payload = Buffer.concat([playerIdBuf, bundleIdBuf, timestampBuf, saltBuf]);
    return createSign('RSA-SHA256').update(payload).sign(privateKey, 'base64');
  }

  it('returns the playerId when the signature, payload and bundleId match', async () => {
    const timestamp = Date.now();
    const salt = Buffer.from('random-salt-bytes').toString('base64');
    const signature = signPayload({ timestampMs: timestamp, saltBase64: salt });

    const result = await verifier.verify({
      publicKeyUrl: PUBLIC_KEY_URL,
      signature,
      salt,
      timestamp,
      playerId: PLAYER_ID,
    });

    expect(result.provider).toBe('APPLE_GAMECENTER');
    expect(result.providerUserId).toBe(PLAYER_ID);
  });

  it('rejects a credential signed for the wrong bundleId', async () => {
    const timestamp = Date.now();
    const salt = Buffer.from('s').toString('base64');
    const signature = signPayload({
      timestampMs: timestamp,
      saltBase64: salt,
      bundleId: 'com.attacker.app',
    });

    await expect(
      verifier.verify({
        publicKeyUrl: PUBLIC_KEY_URL,
        signature,
        salt,
        timestamp,
        playerId: PLAYER_ID,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a credential whose playerId differs from the signed one', async () => {
    const timestamp = Date.now();
    const salt = Buffer.from('s').toString('base64');
    const signature = signPayload({
      timestampMs: timestamp,
      saltBase64: salt,
      playerId: 'A:_real-player',
    });

    await expect(
      verifier.verify({
        publicKeyUrl: PUBLIC_KEY_URL,
        signature,
        salt,
        timestamp,
        playerId: 'A:_spoofed-player',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a stale timestamp', async () => {
    const timestamp = Date.now() - 30 * 60_000; // 30 minutes ago
    const salt = Buffer.from('s').toString('base64');
    const signature = signPayload({ timestampMs: timestamp, saltBase64: salt });

    await expect(
      verifier.verify({
        publicKeyUrl: PUBLIC_KEY_URL,
        signature,
        salt,
        timestamp,
        playerId: PLAYER_ID,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a non-Apple publicKeyUrl', async () => {
    const timestamp = Date.now();
    const salt = Buffer.from('s').toString('base64');
    const signature = signPayload({ timestampMs: timestamp, saltBase64: salt });

    await expect(
      verifier.verify({
        publicKeyUrl: 'https://evil.example.com/cert.cer',
        signature,
        salt,
        timestamp,
        playerId: PLAYER_ID,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a non-HTTPS publicKeyUrl', async () => {
    const timestamp = Date.now();
    const salt = Buffer.from('s').toString('base64');
    const signature = signPayload({ timestampMs: timestamp, saltBase64: salt });

    await expect(
      verifier.verify({
        publicKeyUrl: 'http://static.gc.apple.com/public-key/gc-prod-7.cer',
        signature,
        salt,
        timestamp,
        playerId: PLAYER_ID,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a malformed credential', async () => {
    await expect(verifier.verify({ publicKeyUrl: PUBLIC_KEY_URL } as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('throws when APPLE_GAMECENTER_BUNDLE_ID is missing', async () => {
    config = { get: jest.fn(() => undefined) } as unknown as ConfigService;
    const v = new AppleGameCenterVerifier(config);
    await expect(
      v.verify({
        publicKeyUrl: PUBLIC_KEY_URL,
        signature: 'x',
        salt: 'x',
        timestamp: Date.now(),
        playerId: PLAYER_ID,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
