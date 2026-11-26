import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';

/**
 * Authenticates Pub/Sub push deliveries (Google Play RTDN). The push
 * subscription signs an OIDC token as `GOOGLE_RTDN_PUSH_SERVICE_ACCOUNT` with
 * audience `GOOGLE_RTDN_AUDIENCE`; anything else is rejected with 401.
 */
@Injectable()
export class PubSubPushVerifier {
  private readonly logger = new Logger(PubSubPushVerifier.name);
  private readonly client = new OAuth2Client();

  constructor(private readonly config: ConfigService) {}

  async verify(authorization: string | undefined): Promise<void> {
    const audience = this.config.get<string>('GOOGLE_RTDN_AUDIENCE');
    const expectedEmail = this.config.get<string>('GOOGLE_RTDN_PUSH_SERVICE_ACCOUNT');
    if (!audience || !expectedEmail) {
      throw new ServiceUnavailableException('Google Play RTDN is not configured');
    }

    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
    if (!match) {
      throw new UnauthorizedException('Missing Pub/Sub bearer token');
    }

    let payload;
    try {
      const ticket = await this.client.verifyIdToken({ idToken: match[1], audience });
      payload = ticket.getPayload();
    } catch (err) {
      this.logger.warn(`Pub/Sub OIDC verification failed: ${(err as Error).message}`);
      throw new UnauthorizedException('Invalid Pub/Sub token');
    }

    if (!payload?.email_verified || payload.email?.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new UnauthorizedException('Unexpected Pub/Sub token issuer');
    }
  }
}
