import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  APIError,
  APIException,
  AppStoreServerAPIClient,
  Environment,
  JWSTransactionDecodedPayload,
  ResponseBodyV2DecodedPayload,
  SignedDataVerifier,
  VerificationException,
} from '@apple/app-store-server-library';
import { IapEnvironment } from '@prisma/client';
import { APPLE_ROOT_CERTIFICATES } from './apple-root-certs';

export interface VerifiedAppleTransaction {
  transaction: JWSTransactionDecodedPayload;
  environment: IapEnvironment;
}

const TO_APPLE_ENV: Record<IapEnvironment, Environment> = {
  [IapEnvironment.PRODUCTION]: Environment.PRODUCTION,
  [IapEnvironment.SANDBOX]: Environment.SANDBOX,
};

/**
 * Thin wrapper over Apple's official App Store Server library. Every payload
 * returned here has had its JWS signature chain verified up to Apple Root CA G3
 * and its `bundleId` / `environment` (and `appAppleId` in production) checked.
 */
@Injectable()
export class AppleStoreClient {
  private readonly logger = new Logger(AppleStoreClient.name);
  private readonly apiClients = new Map<IapEnvironment, AppStoreServerAPIClient>();
  private readonly verifiers = new Map<IapEnvironment, SignedDataVerifier>();

  constructor(private readonly config: ConfigService) {}

  /** Looks up a transaction in production first, then sandbox (TestFlight / App Review). */
  async getVerifiedTransaction(transactionId: string): Promise<VerifiedAppleTransaction> {
    for (const environment of [IapEnvironment.PRODUCTION, IapEnvironment.SANDBOX]) {
      try {
        const res = await this.apiClient(environment).getTransactionInfo(transactionId);
        if (!res.signedTransactionInfo) {
          throw new BadGatewayException('Apple returned no transaction info');
        }
        const transaction = await this.verifyTransaction(res.signedTransactionInfo, environment);
        return { transaction, environment };
      } catch (err) {
        if (environment === IapEnvironment.PRODUCTION && isNotFound(err)) continue;
        // Apple's production endpoint answers 401 (no error code) until the app has
        // a version live on the App Store, while sandbox accepts the same key.
        if (environment === IapEnvironment.PRODUCTION && isUnauthorized(err)) {
          this.logger.warn('App Store Server API production returned 401; trying sandbox');
          continue;
        }
        throw this.translate(err);
      }
    }
    throw new NotFoundException('Apple transaction not found');
  }

  async verifyTransaction(
    signedTransactionInfo: string,
    environment: IapEnvironment,
  ): Promise<JWSTransactionDecodedPayload> {
    try {
      return await this.verifier(environment).verifyAndDecodeTransaction(signedTransactionInfo);
    } catch (err) {
      throw this.translate(err);
    }
  }

  async verifyNotification(
    signedPayload: string,
    environment: IapEnvironment,
  ): Promise<ResponseBodyV2DecodedPayload> {
    try {
      return await this.verifier(environment).verifyAndDecodeNotification(signedPayload);
    } catch (err) {
      throw this.translate(err);
    }
  }

  private apiClient(environment: IapEnvironment): AppStoreServerAPIClient {
    let client = this.apiClients.get(environment);
    if (!client) {
      const keyId = this.config.get<string>('APPLE_IAP_KEY_ID');
      const issuerId = this.config.get<string>('APPLE_IAP_ISSUER_ID');
      const keyBase64 = this.config.get<string>('APPLE_IAP_PRIVATE_KEY_BASE64');
      if (!keyId || !issuerId || !keyBase64) {
        throw new ServiceUnavailableException('Apple in-app purchases are not configured');
      }
      const signingKey = Buffer.from(keyBase64, 'base64').toString('utf8');
      client = new AppStoreServerAPIClient(
        signingKey,
        keyId,
        issuerId,
        this.bundleId(),
        TO_APPLE_ENV[environment],
      );
      this.apiClients.set(environment, client);
    }
    return client;
  }

  private verifier(environment: IapEnvironment): SignedDataVerifier {
    let verifier = this.verifiers.get(environment);
    if (!verifier) {
      const appAppleId = this.config.get<number>('APPLE_APP_ID');
      if (environment === IapEnvironment.PRODUCTION && !appAppleId) {
        throw new ServiceUnavailableException('Apple in-app purchases are not configured');
      }
      verifier = new SignedDataVerifier(
        APPLE_ROOT_CERTIFICATES,
        true,
        TO_APPLE_ENV[environment],
        this.bundleId(),
        appAppleId,
      );
      this.verifiers.set(environment, verifier);
    }
    return verifier;
  }

  private bundleId(): string {
    const bundleId = this.config.get<string>('APPLE_GAMECENTER_BUNDLE_ID');
    if (!bundleId) {
      throw new ServiceUnavailableException('Apple in-app purchases are not configured');
    }
    return bundleId;
  }

  private translate(err: unknown): Error {
    if (err instanceof VerificationException) {
      this.logger.warn(`Apple JWS verification failed (status=${err.status})`);
      return new UnauthorizedException('Invalid Apple signed data');
    }
    if (err instanceof APIException) {
      this.logger.warn(`App Store Server API error http=${err.httpStatusCode} api=${err.apiError}`);
      if (isNotFound(err)) return new NotFoundException('Apple transaction not found');
      if (err.httpStatusCode === 400)
        return new BadRequestException('Invalid Apple transaction id');
      return new BadGatewayException('App Store Server API unavailable');
    }
    if (err instanceof Error && 'getStatus' in err) return err;
    this.logger.warn(`Unexpected Apple IAP error: ${(err as Error)?.message}`);
    return new BadGatewayException('App Store Server API unavailable');
  }
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof APIException && err.httpStatusCode === 401;
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof APIException &&
    (err.apiError === APIError.TRANSACTION_ID_NOT_FOUND || err.httpStatusCode === 404)
  );
}
