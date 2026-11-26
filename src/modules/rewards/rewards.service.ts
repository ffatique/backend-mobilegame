import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdmobSsvVerifier } from './admob-ssv.verifier';

/** Coins credited per verified rewarded-ad view. Server-authoritative. */
export const REWARD_COINS = 5;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GrantStatus = 'granted' | 'duplicate' | 'unknown_user' | 'unknown_ad_unit';

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
