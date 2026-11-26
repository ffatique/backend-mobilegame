import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { IapEnvironment } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  AppleNotificationDto,
  AppleVerifyDto,
  GoogleVerifyDto,
  PubSubPushDto,
  VerifyPurchaseResponse,
} from './dto/iap.dto';
import { IapService } from './iap.service';

/**
 * Gem-pack in-app purchases.
 *  - `POST /iap/{apple|google}/verify` (JWT): the Unity client submits a
 *    completed store purchase; gems are credited once and the client may then
 *    finish/confirm the transaction.
 *  - `POST /iap/apple/notifications/{production|sandbox}`: App Store Server
 *    Notifications V2 (JWS-signed by Apple).
 *  - `POST /iap/google/rtdn`: Google Play RTDN via Pub/Sub push (OIDC-signed).
 */
@Controller('iap')
export class IapController {
  constructor(private readonly iap: IapService) {}

  @Post('apple/verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  verifyApple(
    @CurrentUser() user: { id: string },
    @Body() dto: AppleVerifyDto,
  ): Promise<VerifyPurchaseResponse> {
    return this.iap.verifyApple(user.id, dto.transactionId);
  }

  @Post('google/verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  verifyGoogle(
    @CurrentUser() user: { id: string },
    @Body() dto: GoogleVerifyDto,
  ): Promise<VerifyPurchaseResponse> {
    return this.iap.verifyGoogle(user.id, dto.productId, dto.purchaseToken);
  }

  @Post('apple/notifications/production')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle()
  async appleProductionNotification(
    @Body() dto: AppleNotificationDto,
  ): Promise<{ status: string }> {
    const status = await this.iap.handleAppleNotification(
      dto.signedPayload,
      IapEnvironment.PRODUCTION,
    );
    return { status };
  }

  @Post('apple/notifications/sandbox')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle()
  async appleSandboxNotification(@Body() dto: AppleNotificationDto): Promise<{ status: string }> {
    const status = await this.iap.handleAppleNotification(
      dto.signedPayload,
      IapEnvironment.SANDBOX,
    );
    return { status };
  }

  @Post('google/rtdn')
  @HttpCode(HttpStatus.NO_CONTENT)
  @SkipThrottle()
  async googleRtdn(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: PubSubPushDto,
  ): Promise<void> {
    await this.iap.handleGoogleRtdn(authorization, dto);
  }
}
