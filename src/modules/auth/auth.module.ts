import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RefreshTokensService } from './refresh-tokens.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { GooglePlayGamesVerifier } from './providers/google-play-games.verifier';
import { AppleGameCenterVerifier } from './providers/apple-gamecenter.verifier';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    RefreshTokensService,
    JwtStrategy,
    GooglePlayGamesVerifier,
    AppleGameCenterVerifier,
  ],
  exports: [AuthService, RefreshTokensService],
})
export class AuthModule {}
