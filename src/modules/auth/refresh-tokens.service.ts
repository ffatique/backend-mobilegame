import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, RefreshToken } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface IssueOptions {
  /** Continue an existing token family (used during rotation). */
  familyId?: string;
  deviceId?: string;
  userAgent?: string;
  ipHash?: string;
}

export interface IssuedRefreshToken {
  /** Raw token returned to the client ONCE; never persisted. */
  refreshToken: string;
  /** SHA-256 hex of the raw token; this is what we store. */
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  /** Lifetime in seconds, convenient for client-side storage. */
  expiresIn: number;
}

@Injectable()
export class RefreshTokensService {
  private readonly logger = new Logger(RefreshTokensService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Lifetime of a refresh token in milliseconds. Derived from
   * `REFRESH_TOKEN_EXPIRES_IN_DAYS` (validated by the env schema).
   */
  private get ttlMs(): number {
    const days = this.config.get<number>('REFRESH_TOKEN_EXPIRES_IN_DAYS', 60);
    return days * 24 * 60 * 60 * 1000;
  }

  /**
   * Issues a brand-new refresh token row. When `familyId` is omitted a new
   * family is started (initial sign-in); pass an existing `familyId` from
   * `rotate()` to chain rotations together.
   */
  async issue(userId: string, opts: IssueOptions = {}): Promise<IssuedRefreshToken> {
    const raw = randomBytes(48).toString('base64url');
    const tokenHash = sha256Hex(raw);
    const familyId = opts.familyId ?? randomUUID();
    const expiresAt = new Date(Date.now() + this.ttlMs);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash,
        deviceId: opts.deviceId,
        userAgent: truncate(opts.userAgent, 255),
        ipHash: opts.ipHash,
        expiresAt,
      },
    });

    return {
      refreshToken: raw,
      tokenHash,
      familyId,
      expiresAt,
      expiresIn: Math.floor(this.ttlMs / 1000),
    };
  }

  /**
   * Validates and rotates a refresh token. On success the presented token is
   * marked revoked + replaced, and a fresh token (same `familyId`) is issued.
   *
   * Reuse detection: if the presented token is already revoked or replaced,
   * EVERY active token in its family is revoked and we throw — this is the
   * signal that a stolen token is being replayed.
   */
  async rotate(
    rawRefreshToken: string,
    context: Omit<IssueOptions, 'familyId'> = {},
  ): Promise<{ userId: string; issued: IssuedRefreshToken }> {
    const tokenHash = sha256Hex(rawRefreshToken);
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!existing) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (existing.revokedAt || existing.replacedById) {
      // Reuse attack: revoke the entire family.
      await this.revokeFamily(existing.familyId);
      this.logger.warn(
        `Refresh token reuse detected for family ${existing.familyId}; family revoked`,
      );
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const issued = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const raw = randomBytes(48).toString('base64url');
      const newHash = sha256Hex(raw);
      const expiresAt = new Date(Date.now() + this.ttlMs);

      const replacement = await tx.refreshToken.create({
        data: {
          userId: existing.userId,
          familyId: existing.familyId,
          tokenHash: newHash,
          deviceId: context.deviceId ?? existing.deviceId,
          userAgent: truncate(context.userAgent, 255) ?? existing.userAgent,
          ipHash: context.ipHash ?? existing.ipHash,
          expiresAt,
        },
      });

      // Atomically mark the consumed token as revoked + replaced. The guard
      // `revokedAt: null` prevents a concurrent rotation from succeeding
      // twice with the same input.
      const update = await tx.refreshToken.updateMany({
        where: { id: existing.id, revokedAt: null, replacedById: null },
        data: { revokedAt: new Date(), replacedById: replacement.id },
      });

      if (update.count === 0) {
        // Lost the race: another rotation already consumed this token.
        throw new UnauthorizedException('Refresh token reuse detected');
      }

      return {
        refreshToken: raw,
        tokenHash: newHash,
        familyId: existing.familyId,
        expiresAt,
        expiresIn: Math.floor(this.ttlMs / 1000),
      } satisfies IssuedRefreshToken;
    });

    return { userId: existing.userId, issued };
  }

  /**
   * Revokes every still-active token in a family. Used both for explicit
   * device sign-out and as the response to detected reuse.
   */
  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Revokes every still-active refresh token belonging to a user.
   * Intended for "sign out of all devices".
   */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Revokes a single token by raw value. Used by `POST /auth/logout` when the
   * caller supplies the refresh token they want to invalidate.
   *
   * Returns `true` if a token was actually revoked. Silent no-op for unknown,
   * already-revoked, or replaced tokens — we deliberately do not leak whether
   * a hash exists.
   */
  async revokeRaw(userId: string, rawRefreshToken: string): Promise<boolean> {
    const tokenHash = sha256Hex(rawRefreshToken);
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count > 0;
  }

  /**
   * Retrieves the raw row for a hashed token. Test-only convenience.
   */
  async findByHashForTest(tokenHash: string): Promise<RefreshToken | null> {
    return this.prisma.refreshToken.findUnique({ where: { tokenHash } });
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}
