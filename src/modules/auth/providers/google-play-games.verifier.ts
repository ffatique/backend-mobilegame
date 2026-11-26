import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthProviderType } from '@prisma/client';
import { OAuth2Client } from 'google-auth-library';
import type { ProviderVerifier, VerifiedProviderIdentity } from './provider-verifier.interface';

/**
 * Verifies a Google Play Games server auth code obtained by the Unity client
 * via Play Games Services. The code is exchanged for an OAuth2 access token,
 * then `games.players.get('me')` returns the canonical playerId.
 *
 * The raw `playerId` reported by the client SDK MUST NOT be trusted alone — it
 * is not secret. Only this server-side exchange proves the request is from the
 * holder of that account.
 */
@Injectable()
export class GooglePlayGamesVerifier implements ProviderVerifier {
  readonly provider = AuthProviderType.GOOGLE_PLAY;
  private readonly logger = new Logger(GooglePlayGamesVerifier.name);

  constructor(private readonly config: ConfigService) {}

  async verify(serverAuthCode: string): Promise<VerifiedProviderIdentity> {
    const clientId = this.config.get<string>('GOOGLE_PLAY_GAMES_CLIENT_ID');
    const clientSecret = this.config.get<string>('GOOGLE_PLAY_GAMES_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      this.logger.error('Google Play Games OAuth credentials are not configured');
      throw new UnauthorizedException('Provider not configured');
    }

    const oauth2Client = new OAuth2Client({
      clientId,
      clientSecret,
      // Play Games Services uses the special redirect URI value below when
      // exchanging server auth codes obtained from a mobile client.
      redirectUri: '',
    });

    try {
      const { tokens } = await oauth2Client.getToken(serverAuthCode);
      if (!tokens.access_token) {
        throw new UnauthorizedException('Invalid Google Play Games auth code');
      }
      oauth2Client.setCredentials(tokens);

      const { data } = await oauth2Client.request<{
        playerId?: string;
        displayName?: string;
        avatarImageUrl?: string;
      }>({
        url: 'https://games.googleapis.com/games/v1/players/me',
      });

      if (!data.playerId) {
        throw new UnauthorizedException('Google Play Games response missing playerId');
      }

      return {
        provider: this.provider,
        providerUserId: data.playerId,
        displayName: data.displayName ?? undefined,
        avatar: data.avatarImageUrl,
      };
    } catch (err) {
      // Avoid leaking provider error details to the client.
      this.logger.warn('Google Play Games verification failed');
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid Google Play Games auth code');
    }
  }
}
