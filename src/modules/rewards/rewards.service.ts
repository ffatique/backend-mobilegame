import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdmobSsvVerifier } from './admob-ssv.verifier';

/** Coins credited per verified rewarded-ad view. Server-authoritative. */
export const REWARD_COINS = 5;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GrantStatus =
  | 'granted'
  | 'duplicate'
  | 'unknown_user'
  | 'unknown_ad_unit'
  | 'unknown_ticket';

export interface GrantResult {
  status: GrantStatus;
}

@Injectable()
export class RewardsService {
  private readonly logger = new Logger(RewardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly verifier: AdmobSsvVerifier,
    private readonly config: ConfigService,
  ) {}

  private installation(token?: string) {
    if (!token || !/^Installation [a-f0-9]{64}$/.test(token))
      throw new UnauthorizedException('Missing installation credential');
    return createHash('sha256').update(token).digest('hex');
  }

  async guestAvailability(token?: string) {
    const installation = this.installation(token);
    const day = new Date(new Date().toISOString().slice(0, 10));
    const used = await this.prisma.baitOperation.count({ where: { installation, day } });
    return { slots: Math.max(0, 3 - used) };
  }

  async guestTicket(token: string, key: string, session: string, milestone: number) {
    const installation = this.installation(token);
    if (milestone % 5) throw new ConflictException('No offer available');
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${installation},0))`;
      const day = new Date(new Date().toISOString().slice(0, 10));
      const prior = await tx.baitOperation.findUnique({ where: { id: key } });
      if (
        prior?.installation === installation &&
        prior.session === session &&
        prior.milestone === milestone
      )
        return { ticket: key };
      if (
        prior ||
        (await tx.baitOperation.count({ where: { installation, day } })) >= 3 ||
        (await tx.baitOperation.findFirst({ where: { installation, session, milestone } }))
      )
        throw new ConflictException('Offer already used');
      await tx.baitOperation.create({
        data: { id: key, kind: 'guest', installation, session, day, milestone },
      });
      return { ticket: key };
    });
  }

  async guestStatus(token: string, key: string) {
    const installation = this.installation(token);
    const ticket = await this.prisma.baitOperation.findFirst({ where: { id: key, installation } });
    return { granted: !!ticket?.transactionId };
  }

  /**
   * Verifies an AdMob rewarded SSV callback and, if valid, credits the player
   * with `REWARD_COINS`. Idempotent per AdMob `transaction_id`: a replayed or
   * retried callback is a no-op. `rawQuery` MUST be the callback's raw query
   * string (no leading `?`) so the signature is checked over the exact bytes
   * AdMob signed.
   *
   * Throws `UnauthorizedException` (via the verifier) when the signature is
   * invalid. Returns a status describing the outcome for logging.
   */
  async grantFromSsv(rawQuery: string): Promise<GrantResult> {
    await this.verifier.verify(rawQuery);

    const params = new URLSearchParams(rawQuery);
    const userId = params.get('user_id') ?? '';
    const transactionId = params.get('transaction_id') ?? '';

    if (!UUID_RE.test(userId) || !transactionId) {
      // Signed by AdMob but not addressable to a player — nothing to grant.
      this.logger.warn(
        `AdMob SSV callback has no usable user_id/transaction_id (txn=${transactionId || 'none'})`,
      );
      return { status: 'unknown_user' };
    }

    // This rewarded unit belongs to My Little Pier. AdMob signs both player and ticket.
    if (params.get('ad_unit') === '2697891384') {
      const custom = params.get('custom_data') ?? '';
      const guest = custom.startsWith('guest.');
      const ticket = guest ? custom.slice(6) : custom;
      if (guest && userId !== ticket) return { status: 'unknown_ticket' };
      if (!UUID_RE.test(ticket)) return { status: 'unknown_ticket' };
      try {
        return await this.prisma.$transaction(async (tx) => {
          const reserved = await tx.baitOperation.updateMany({
            where: guest
              ? { id: ticket, kind: 'guest', transactionId: null }
              : { id: ticket, playerId: userId, kind: 'ad', transactionId: null },
            data: { transactionId },
          });
          if (!reserved.count) {
            const prior = await tx.baitOperation.findUnique({ where: { id: ticket } });
            return {
              status: prior?.transactionId === transactionId ? 'duplicate' : 'unknown_ticket',
            };
          }
          if (!guest)
            await tx.pierSave.update({
              where: { playerId: userId },
              data: { bonusBait: { increment: 3 } },
            });
          return { status: 'granted' };
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
          return { status: 'duplicate' };
        throw err;
      }
    }

    const units = this.config.getOrThrow<string[]>('ADMOB_REWARDED_AD_UNITS');
    if (!units.length) throw new ServiceUnavailableException('AdMob units are not configured');
    if (!units.includes(params.get('ad_unit') ?? '')) return { status: 'unknown_ad_unit' };

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) {
      this.logger.warn(`AdMob SSV callback for unknown user (txn=${transactionId})`);
      return { status: 'unknown_user' };
    }

    const data: Prisma.AdRewardGrantUncheckedCreateInput = {
      userId,
      transactionId,
      adUnit: params.get('ad_unit') ?? null,
      adNetwork: params.get('ad_network') ?? null,
      rewardItem: params.get('reward_item') ?? null,
      rewardAmount: this.parseInt(params.get('reward_amount')),
      coinsGranted: REWARD_COINS,
      rewardedAt: this.parseTimestamp(params.get('timestamp')),
    };

    try {
      await this.prisma.$transaction([
        this.prisma.adRewardGrant.create({ data }),
        this.prisma.user.update({
          where: { id: userId },
          data: { coins: { increment: REWARD_COINS } },
        }),
      ]);
      return { status: 'granted' };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Unique violation on transactionId: this reward was already granted.
        return { status: 'duplicate' };
      }
      throw err;
    }
  }

  private parseInt(value: string | null): number {
    const n = Number(value);
    return Number.isInteger(n) ? n : 0;
  }

  /** AdMob's `timestamp` is epoch time; some SDKs report microseconds. */
  private parseTimestamp(value: string | null): Date {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return new Date();
    return new Date(n > 1e14 ? Math.trunc(n / 1000) : n);
  }
}
