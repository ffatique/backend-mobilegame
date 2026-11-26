import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { androidpublisher_v3 } from '@googleapis/androidpublisher';
import * as google from '@googleapis/androidpublisher';

export type GoogleProductPurchase = androidpublisher_v3.Schema$ProductPurchase;

/** Android Publisher API wrapper authenticated with the IAP service account. */
@Injectable()
export class GooglePlayClient {
  private readonly logger = new Logger(GooglePlayClient.name);
  private publisher?: androidpublisher_v3.Androidpublisher;

  constructor(private readonly config: ConfigService) {}

  get packageName(): string {
    const name = this.config.get<string>('GOOGLE_PLAY_PACKAGE_NAME');
    if (!name) {
      throw new ServiceUnavailableException('Google Play in-app purchases are not configured');
    }
    return name;
  }

  async getProductPurchase(productId: string, token: string): Promise<GoogleProductPurchase> {
    try {
      const { data } = await this.client().purchases.products.get({
        packageName: this.packageName,
        productId,
        token,
      });
      return data;
    } catch (err) {
      throw this.translate(err);
    }
  }

  async consume(productId: string, token: string): Promise<void> {
    try {
      await this.client().purchases.products.consume({
        packageName: this.packageName,
        productId,
        token,
      });
    } catch (err) {
      throw this.translate(err);
    }
  }

  private client(): androidpublisher_v3.Androidpublisher {
    if (!this.publisher) {
      const encoded = this.config.get<string>('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64');
      if (!encoded) {
        throw new ServiceUnavailableException('Google Play in-app purchases are not configured');
      }
      const credentials = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
      });
      this.publisher = google.androidpublisher({ version: 'v3', auth });
    }
    return this.publisher;
  }

  private translate(err: unknown): Error {
    if (err instanceof Error && 'getStatus' in err) return err;
    const status = httpStatusOf(err);
    this.logger.warn(`Android Publisher API error http=${status ?? 'n/a'}`);
    if (status === 400 || status === 404 || status === 410) {
      return new BadRequestException('Invalid Google Play purchase');
    }
    return new BadGatewayException('Google Play API unavailable');
  }
}

function httpStatusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const candidate of [e?.response?.status, e?.status, e?.code]) {
    if (typeof candidate === 'number') return candidate;
  }
  return undefined;
}
