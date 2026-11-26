import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthProviderType } from '@prisma/client';
import { GooglePlayGamesVerifier } from './providers/google-play-games.verifier';
import {
  AppleGameCenterVerifier,
  type AppleGameCenterCredential,
} from './providers/apple-gamecenter.verifier';
import type {
  ProviderCredential,
  ProviderVerifier,
  VerifiedProviderIdentity,
} from './providers/provider-verifier.interface';
import {
  RefreshTokensService,
  type IssueOptions,
  type IssuedRefreshToken,
} from './refresh-tokens.service';

export interface JwtPayload {
  sub: string; // player ID
}

export interface AccessToken {
  accessToken: string;
  expiresIn: string;
}

export interface TokenPair extends AccessToken {
  refreshToken: string;
  refreshExpiresAt: Date;
  refreshExpiresIn: number;
}

@Injectable()
export class AuthService {
  private readonly verifiers: Map<AuthProviderType, ProviderVerifier>;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly refreshTokens: RefreshTokensService,
    googlePlayGames: GooglePlayGamesVerifier,
    appleGameCenter: AppleGameCenterVerifier,
  ) {
    this.verifiers = new Map<AuthProviderType, ProviderVerifier>([
      [googlePlayGames.provider, googlePlayGames],
      [appleGameCenter.provider, appleGameCenter],
    ]);
  }

  /**
   * Validates a third-party identity credential and returns the canonical
   * identity. Each provider has its own credential shape — see the per-method
   * helpers below for typed entrypoints. Throws `UnauthorizedException` for
   * unknown providers or invalid credentials.
   */
  async verifyProviderToken(
    provider: AuthProviderType,
    credential: ProviderCredential,
  ): Promise<VerifiedProviderIdentity> {
    const verifier = this.verifiers.get(provider);
    if (!verifier) {
      throw new UnauthorizedException(`Provider ${provider} is not supported yet`);
    }
    return verifier.verify(credential);
  }

  /** Convenience wrapper for the Google Play Games server-auth-code flow. */
  verifyGooglePlayGames(serverAuthCode: string): Promise<VerifiedProviderIdentity> {
    return this.verifyProviderToken(AuthProviderType.GOOGLE_PLAY, serverAuthCode);
  }

  /** Convenience wrapper for the Apple Game Center signature-verification flow. */
  verifyAppleGameCenter(credential: AppleGameCenterCredential): Promise<VerifiedProviderIdentity> {
    return this.verifyProviderToken(
      AuthProviderType.APPLE_GAMECENTER,
      credential as unknown as Record<string, unknown>,
    );
  }

  /**
   * Issues a signed JWT access token for a given player ID.
   */
  issueAccessToken(playerId: string): AccessToken {
    const expiresIn = this.config.get<string>('JWT_EXPIRES_IN', '1h');
    const payload: JwtPayload = { sub: playerId };
    // Cast: Nest's JwtSignOptions expects ms's `StringValue` literal union,
    // which is incompatible with our config-supplied `string`. The token
    // module validates the value at sign time anyway.
    const accessToken = this.jwt.sign(payload, { expiresIn } as never);
    return { accessToken, expiresIn };
  }

  /**
   * Issues an access token + a brand-new refresh token (new family). Used at
   * sign-in / sign-up time.
   */
  async issueTokenPair(playerId: string, ctx: IssueOptions = {}): Promise<TokenPair> {
    const access = this.issueAccessToken(playerId);
    const refresh = await this.refreshTokens.issue(playerId, ctx);
    return toPair(access, refresh);
  }

  /**
   * Rotates the supplied refresh token and returns a fresh access + refresh
   * pair (same family). Throws `UnauthorizedException` on any failure (unknown
   * token, expired, revoked, reused).
   */
  async refreshTokenPair(
    rawRefreshToken: string,
    ctx: Omit<IssueOptions, 'familyId'> = {},
  ): Promise<TokenPair> {
    const { userId, issued } = await this.refreshTokens.rotate(rawRefreshToken, ctx);
    const access = this.issueAccessToken(userId);
    return toPair(access, issued);
  }
}

function toPair(access: AccessToken, refresh: IssuedRefreshToken): TokenPair {
  return {
    accessToken: access.accessToken,
    expiresIn: access.expiresIn,
    refreshToken: refresh.refreshToken,
    refreshExpiresAt: refresh.expiresAt,
    refreshExpiresIn: refresh.expiresIn,
  };
}
