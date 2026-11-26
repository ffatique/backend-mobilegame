import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthProviderType } from '@prisma/client';
import { createVerify, X509Certificate } from 'node:crypto';
import { gameCenterIssuer } from './gamecenter-issuer';
import type { ProviderVerifier, VerifiedProviderIdentity } from './provider-verifier.interface';

/**
 * Credential returned by GameKit's `GKLocalPlayer.fetchItems(forIdentityVerification:)`.
 * The Unity client forwards these fields verbatim to the backend.
 *
 * IMPORTANT: `playerId` here is the value the client sends — it is NOT trusted
 * on its own. Trust is established by validating that the Apple-signed payload
 * (which embeds this same `playerId` together with our bundleId, the salt and
 * the timestamp) verifies against Apple's public certificate.
 */
export interface AppleGameCenterCredential {
  /** Apple-hosted URL pointing at the DER-encoded certificate used to sign the payload. */
  publicKeyUrl: string;
  /** Base64-encoded RSA signature over the canonical payload. */
  signature: string;
  /** Base64-encoded random salt that was incorporated into the signed payload. */
  salt: string;
  /** Unix timestamp in **milliseconds**, big-endian uint64 in the signed payload. */
  timestamp: number;
  /** GameKit playerID (or teamPlayerID for newer iOS) the client claims to be. */
  playerId: string;
}

interface CachedCertificate {
  expiresAt: number;
  publicKeyPem: string;
}

/** Verifies the GameKit signature over the player ID, configured bundle ID, timestamp and salt. */
@Injectable()
export class AppleGameCenterVerifier implements ProviderVerifier {
  readonly provider = AuthProviderType.APPLE_GAMECENTER;
  private readonly logger = new Logger(AppleGameCenterVerifier.name);

  /** Reject signed payloads older than this. */
  private static readonly MAX_TIMESTAMP_AGE_MS = 10 * 60_000; // 10 minutes
  /** Allow a small clock skew toward the future. */
  private static readonly MAX_TIMESTAMP_SKEW_MS = 60_000; // 1 minute
  /** TTL for the in-memory certificate cache. */
  private static readonly CERT_CACHE_TTL_MS = 60 * 60_000; // 1 hour

  private readonly certCache = new Map<string, CachedCertificate>();

  constructor(private readonly config: ConfigService) {}

  async verify(credential: unknown): Promise<VerifiedProviderIdentity> {
    const bundleId = this.config.get<string>('APPLE_GAMECENTER_BUNDLE_ID');
    if (!bundleId) {
      this.logger.error('APPLE_GAMECENTER_BUNDLE_ID is not configured');
      throw new UnauthorizedException('Provider not configured');
    }

    const payload = this.parseCredential(credential);

    try {
      this.assertPublicKeyUrl(payload.publicKeyUrl);
      this.assertFreshTimestamp(payload.timestamp);

      const publicKeyPem = await this.loadPublicKey(payload.publicKeyUrl);

      const verifiablePayload = this.buildSignedPayload({
        playerId: payload.playerId,
        bundleId,
        timestampMs: payload.timestamp,
        saltBase64: payload.salt,
      });

      const ok = createVerify('RSA-SHA256')
        .update(verifiablePayload)
        .verify(publicKeyPem, payload.signature, 'base64');

      if (!ok) {
        throw new UnauthorizedException('Invalid Apple Game Center signature');
      }

      return {
        provider: this.provider,
        providerUserId: payload.playerId,
      };
    } catch (err) {
      this.logger.warn(`Apple Game Center verification failed: ${(err as Error).message}`);
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid Apple Game Center credential');
    }
  }

  private parseCredential(credential: unknown): AppleGameCenterCredential {
    if (!credential || typeof credential !== 'object') {
      throw new UnauthorizedException('Malformed Apple Game Center credential');
    }
    const c = credential as Record<string, unknown>;

    const publicKeyUrl = typeof c.publicKeyUrl === 'string' ? c.publicKeyUrl : '';
    const signature = typeof c.signature === 'string' ? c.signature : '';
    const salt = typeof c.salt === 'string' ? c.salt : '';
    const playerId = typeof c.playerId === 'string' ? c.playerId : '';
    const timestamp = typeof c.timestamp === 'number' ? c.timestamp : Number(c.timestamp);

    if (!publicKeyUrl || !signature || !salt || !playerId || !Number.isFinite(timestamp)) {
      throw new UnauthorizedException('Malformed Apple Game Center credential');
    }

    return { publicKeyUrl, signature, salt, timestamp, playerId };
  }

  private assertPublicKeyUrl(publicKeyUrl: string): void {
    let url: URL;
    try {
      url = new URL(publicKeyUrl);
    } catch {
      throw new UnauthorizedException('Invalid Apple Game Center public key URL');
    }
    if (url.protocol !== 'https:') {
      throw new UnauthorizedException('Apple Game Center public key URL must be HTTPS');
    }
    const host = url.hostname.toLowerCase();
    if (
      host !== 'static.gc.apple.com' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/public-key\/[a-zA-Z0-9_-]+\.cer$/.test(url.pathname)
    ) {
      throw new UnauthorizedException('Apple Game Center unrecognized Game Center certificate URL');
    }
  }

  private assertFreshTimestamp(timestampMs: number): void {
    const now = Date.now();
    if (timestampMs > now + AppleGameCenterVerifier.MAX_TIMESTAMP_SKEW_MS) {
      throw new UnauthorizedException('Apple Game Center timestamp is in the future');
    }
    if (now - timestampMs > AppleGameCenterVerifier.MAX_TIMESTAMP_AGE_MS) {
      throw new UnauthorizedException('Apple Game Center timestamp is stale');
    }
  }

  private async loadPublicKey(publicKeyUrl: string): Promise<string> {
    const cached = this.certCache.get(publicKeyUrl);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.publicKeyPem;
    }

    const res = await fetch(publicKeyUrl, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      throw new UnauthorizedException('Unable to fetch Apple Game Center public key');
    }
    const der = Buffer.from(await res.arrayBuffer());

    let cert: X509Certificate;
    try {
      cert = new X509Certificate(der);
    } catch {
      throw new UnauthorizedException('Apple Game Center public key is not a valid certificate');
    }

    const now = Date.now();
    const validUntil = Math.min(Date.parse(cert.validTo), Date.parse(gameCenterIssuer.validTo));
    if (
      now < Math.max(Date.parse(cert.validFrom), Date.parse(gameCenterIssuer.validFrom)) ||
      now >= validUntil ||
      cert.ca ||
      !cert.checkIssued(gameCenterIssuer) ||
      !cert.verify(gameCenterIssuer.publicKey)
    ) {
      throw new UnauthorizedException('Untrusted Apple Game Center certificate');
    }

    const publicKeyPem = cert.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const cacheControl = res.headers.get('cache-control') ?? '';
    const maxAge = cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i);
    const ttl = Math.min(
      AppleGameCenterVerifier.CERT_CACHE_TTL_MS,
      maxAge ? Number(maxAge[1]) * 1000 : AppleGameCenterVerifier.CERT_CACHE_TTL_MS,
    );
    if (ttl > 0 && !/no-cache|no-store/i.test(cacheControl)) {
      this.certCache.set(publicKeyUrl, {
        expiresAt: Math.min(now + ttl, validUntil),
        publicKeyPem,
      });
    }
    return publicKeyPem;
  }

  private buildSignedPayload(parts: {
    playerId: string;
    bundleId: string;
    timestampMs: number;
    saltBase64: string;
  }): Buffer {
    const playerIdBuf = Buffer.from(parts.playerId, 'utf8');
    const bundleIdBuf = Buffer.from(parts.bundleId, 'utf8');

    const timestampBuf = Buffer.alloc(8);
    // Apple specifies a big-endian 64-bit unsigned integer of milliseconds.
    timestampBuf.writeBigUInt64BE(BigInt(Math.trunc(parts.timestampMs)));

    const saltBuf = Buffer.from(parts.saltBase64, 'base64');

    return Buffer.concat([playerIdBuf, bundleIdBuf, timestampBuf, saltBuf]);
  }
}
