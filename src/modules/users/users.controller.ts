import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthService } from '../auth/auth.service';
import type { VerifiedProviderIdentity } from '../auth/providers/provider-verifier.interface';
import { CreateUserAppleDto } from './dto/create-user-apple.dto';
import { CreateUserGoogleDto } from './dto/create-user-google.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
  ) {}

  @Post('google')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async google(@Body() dto: CreateUserGoogleDto) {
    const identity = await this.auth.verifyGooglePlayGames(dto.authToken);
    return this.login(identity, dto.name);
  }

  @Post('apple')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async apple(@Body() dto: CreateUserAppleDto) {
    const identity = await this.auth.verifyAppleGameCenter(dto);
    return this.login(identity, dto.name);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: { id: string }) {
    return this.users.profile(user.id);
  }

  private async login(identity: VerifiedProviderIdentity, name?: string) {
    const { id } = await this.users.signIn(identity, name);
    const tokens = await this.auth.issueTokenPair(id);
    return { playerId: id, ...tokens };
  }
}
