import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService, type TokenPair } from './auth.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RefreshTokensService } from './refresh-tokens.service';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { LogoutDto } from './dto/logout.dto';

export interface RefreshResponse {
  accessToken: string;
  expiresIn: string;
  refreshToken: string;
  refreshExpiresIn: number;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly refreshTokens: RefreshTokensService,
  ) {}

  /**
   * Exchanges a still-valid refresh token for a fresh access + refresh pair.
   * Implements rotation with reuse detection — see `RefreshTokensService`.
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async refresh(@Body() dto: RefreshTokenDto): Promise<RefreshResponse> {
    const pair = await this.auth.refreshTokenPair(dto.refreshToken);
    return toRefreshResponse(pair);
  }

  /**
   * Revokes refresh tokens for the authenticated user. By default revokes the
   * single token supplied in the body; pass `allDevices: true` to invalidate
   * every active session of this user.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async logout(@CurrentUser() user: { id: string }, @Body() dto: LogoutDto): Promise<void> {
    if (dto.allDevices) {
      await this.refreshTokens.revokeAllForUser(user.id);
      return;
    }
    if (!dto.refreshToken) {
      throw new BadRequestException('Provide refreshToken or set allDevices to true');
    }
    await this.refreshTokens.revokeRaw(user.id, dto.refreshToken);
  }
}

function toRefreshResponse(pair: TokenPair): RefreshResponse {
  return {
    accessToken: pair.accessToken,
    expiresIn: pair.expiresIn,
    refreshToken: pair.refreshToken,
    refreshExpiresIn: pair.refreshExpiresIn,
  };
}
