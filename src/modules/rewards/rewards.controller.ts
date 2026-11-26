import { Controller, Get, HttpCode, HttpStatus, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { RewardsService } from './rewards.service';

/**
 * Public callback endpoint hit by AdMob's servers (not the game client) after
 * a player finishes a rewarded ad. It is unauthenticated by design — trust is
 * established by verifying the ECDSA signature AdMob appends to the callback,
 * so no `JwtAuthGuard` is used and throttling is skipped (Google retries up to
 * 5x on non-200 responses).
 *
 * Configure this URL in the AdMob ad unit's "Server-side verification" setting.
 * The Unity client must set `user_id` to the player's playerId via the SDK's
 * ServerSideVerificationOptions so we know who to reward.
 */
@SkipThrottle()
@Controller('rewards')
export class RewardsController {
  constructor(private readonly rewards: RewardsService) {}

  @Get('admob/ssv')
  @HttpCode(HttpStatus.OK)
  async admobSsv(@Req() req: Request): Promise<{ status: string }> {
    // Use the RAW query string (not parsed params) so the signature is checked
    // over the exact bytes AdMob signed.
    const qIndex = req.originalUrl.indexOf('?');
    const rawQuery = qIndex === -1 ? '' : req.originalUrl.slice(qIndex + 1);

    const result = await this.rewards.grantFromSsv(rawQuery);
    return { status: result.status };
  }
}
