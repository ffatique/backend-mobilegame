import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verify as cryptoVerify } from 'node:crypto';

interface CachedKeys {
  fetchedAt: number;
  keys: Map<number, string>; // keyId -> PEM public key
}

/**
 * Verifies AdMob rewarded server-side verification (SSV) callbacks.
 *
 * AdMob calls our callback URL with query parameters describing the reward.
 * The last two parameters are always `signature` and `key_id` (in that order);
 * everything before `&signature=` is the signed content. The signature is a
 * DER-encoded ECDSA (NIST P-256 / SHA-256) value, base64url-encoded. Public
 * keys are published (and rotated) at Google's key server, keyed by `key_id`.
 *
 * Docs: https://developers.google.com/admob/android/ssv
 *
 * Any failure throws `UnauthorizedException` with a generic message; the
 * specific reason is only logged server-side. The raw signature is never logged.
 */
@Injectable()
export class AdmobSsvVerifier {
  private readonly logger = new Logger(AdmobSsvVerifier.name);

  /** Google rotates keys on a variable schedule; cache no longer than 24h. */
  private static readonly KEYS_CACHE_TTL_MS = 12 * 60 * 60_000; // 12 hours

  private cached?: CachedKeys;

  constructor(private readonly config: ConfigService) {}

  /**
   * Verifies the signature over `rawQuery` (the callback URL's query string,
   * WITHOUT a leading `?`). Throws if the signature is missing, malformed, or
   * does not verify against the AdMob public key referenced by `key_id`.
   */
  async verify(rawQuery: string): Promise<void> {
    try {
      const { content, signature, keyId } = this.splitQuery(rawQuery);

      const keys = await this.loadKeys();
      const pem = keys.get(keyId);
      if (!pem) {
        throw new UnauthorizedException(`No AdMob public key for key_id ${keyId}`);
      }

      const ok = cryptoVerify(
        'sha256',
        Buffer.from(content, 'utf8'),
        { key: pem, dsaEncoding: 'der' },
        signature,
      );
      if (!ok) {
        throw new UnauthorizedException('Invalid AdMob SSV signature');
      }
    } catch (err) {
      this.logger.warn(`AdMob SSV verification failed: ${(err as Error).message}`);
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid AdMob SSV callback');
    }
  }

  /**
   * Splits the raw query string into the signed content and the trailing
   * `signature`/`key_id` values. The content must be byte-for-byte what AdMob
   * signed, so we slice the original string rather than re-serializing parsed
   * params.
   */
  private splitQuery(rawQuery: string): { content: string; signature: Buffer; keyId: number } {
    const sigMarker = rawQuery.indexOf('&signature=');
    if (sigMarker === -1) {
      throw new UnauthorizedException('AdMob SSV callback is missing a signature');
    }
    const content = rawQuery.slice(0, sigMarker);

    if (!/^&signature=[^&]+&key_id=\d+$/.test(rawQuery.slice(sigMarker))) {
      throw new UnauthorizedException('Invalid AdMob signature fields');
    }
    const params = new URLSearchParams(rawQuery.slice(sigMarker + 1));
    const signatureRaw = params.get('signature');
    const keyIdRaw = params.get('key_id');
    if (!signatureRaw || !keyIdRaw) {
      throw new UnauthorizedException('AdMob SSV callback is missing signature or key_id');
    }

    const keyId = Number(keyIdRaw);
    if (!Number.isInteger(keyId)) {
      throw new UnauthorizedException('AdMob SSV key_id is not an integer');
    }

    const signature = Buffer.from(signatureRaw, 'base64url');
    if (signature.length === 0) {
      throw new UnauthorizedException('AdMob SSV signature is empty');
    }

    return { content, signature, keyId };
  }

  private async loadKeys(): Promise<Map<number, string>> {
    if (this.cached && Date.now() - this.cached.fetchedAt < AdmobSsvVerifier.KEYS_CACHE_TTL_MS) {
      return this.cached.keys;
    }

    const url =
      this.config.get<string>('ADMOB_SSV_KEYS_URL') ??
      'https://www.gstatic.com/admob/reward/verifier-keys.json';

    const res = await fetch(url);
    if (!res.ok) {
      throw new UnauthorizedException('Unable to fetch AdMob public keys');
    }

    const body = (await res.json()) as { keys?: Array<{ keyId?: number; pem?: string }> };
    const keys = new Map<number, string>();
    for (const entry of body.keys ?? []) {
      if (typeof entry.keyId === 'number' && typeof entry.pem === 'string') {
        keys.set(entry.keyId, entry.pem);
      }
    }
    if (keys.size === 0) {
      throw new UnauthorizedException('AdMob key server returned no usable keys');
    }

    this.cached = { fetchedAt: Date.now(), keys };
    return keys;
  }
}
