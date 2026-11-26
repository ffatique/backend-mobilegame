import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { AdmobSsvVerifier } from './admob-ssv.verifier';

const KEY_ID = 1916455855;
const KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';

describe('AdmobSsvVerifier', () => {
  let privateKey: KeyObject;
  let publicKeyPem: string;
  let verifier: AdmobSsvVerifier;
  let config: ConfigService;
  let fetchMock: jest.Mock;

  beforeAll(() => {
    const { privateKey: priv, publicKey: pub } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    privateKey = priv;
    publicKeyPem = pub.export({ type: 'spki', format: 'pem' }).toString();
  });

  beforeEach(() => {
    config = {
      get: jest.fn((key: string) => (key === 'ADMOB_SSV_KEYS_URL' ? KEYS_URL : undefined)),
    } as unknown as ConfigService;
    verifier = new AdmobSsvVerifier(config);

    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [{ keyId: KEY_ID, pem: publicKeyPem }] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  /** Signs `content` and returns the full query string AdMob would send. */
  function buildQuery(content: string, opts?: { keyId?: number; tamper?: boolean }): string {
    const signature = cryptoSign('sha256', Buffer.from(content, 'utf8'), {
      key: privateKey,
      dsaEncoding: 'der',
    });
    const sig = signature.toString('base64url');
    const signed = opts?.tamper ? `${content}&extra=1` : content;
    return `${signed}&signature=${sig}&key_id=${opts?.keyId ?? KEY_ID}`;
  }

  const CONTENT =
    'ad_network=1953547073528090325&ad_unit=2747237135&reward_amount=5&reward_item=coins' +
    '&timestamp=1700000000000&transaction_id=18fa792de1bca816048293fc71035638' +
    '&user_id=11111111-1111-4111-8111-111111111111';

  it('resolves for a valid signature and caches the keys', async () => {
    await expect(verifier.verify(buildQuery(CONTENT))).resolves.toBeUndefined();
    // Second call must hit the cache, not the network again.
    await expect(verifier.verify(buildQuery(CONTENT))).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when the signed content was tampered with', async () => {
    await expect(verifier.verify(buildQuery(CONTENT, { tamper: true }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects parameters appended after the signature fields', async () => {
    await expect(verifier.verify(buildQuery(CONTENT) + '&extra=1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an unknown key_id', async () => {
    await expect(verifier.verify(buildQuery(CONTENT, { keyId: 999 }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when the signature parameter is missing', async () => {
    await expect(verifier.verify(`${CONTENT}&key_id=${KEY_ID}`)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when the key server returns no keys', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ keys: [] }) });
    await expect(verifier.verify(buildQuery(CONTENT))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when the key server is unreachable', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    await expect(verifier.verify(buildQuery(CONTENT))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
