import {
  BadGatewayException,
  BadRequestException,
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
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from '@apple/app-store-server-library';
import { IapEnvironment } from '@prisma/client';
import { AppleStoreClient } from './apple-store.client';

jest.mock('@apple/app-store-server-library', () => {
  const actual = jest.requireActual('@apple/app-store-server-library');
  return { ...actual, AppStoreServerAPIClient: jest.fn(), SignedDataVerifier: jest.fn() };
});

const ApiClientMock = AppStoreServerAPIClient as unknown as jest.Mock;
const VerifierMock = SignedDataVerifier as unknown as jest.Mock;

const FULL_CONFIG: Record<string, unknown> = {
  APPLE_IAP_KEY_ID: 'KEY',
  APPLE_IAP_ISSUER_ID: 'ISSUER',
  APPLE_IAP_PRIVATE_KEY_BASE64: Buffer.from('mock signing key').toString('base64'),
  APPLE_APP_ID: 123,
  APPLE_GAMECENTER_BUNDLE_ID: 'com.test.app',
};

function config(values: Record<string, unknown> = FULL_CONFIG): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

describe('AppleStoreClient', () => {
  const getTransactionInfo: Record<string, jest.Mock> = {};
  const verifiers: Record<
    string,
    { verifyAndDecodeTransaction: jest.Mock; verifyAndDecodeNotification: jest.Mock }
  > = {};

  beforeEach(() => {
    ApiClientMock.mockReset();
    VerifierMock.mockReset();
    for (const env of [Environment.PRODUCTION, Environment.SANDBOX]) {
      getTransactionInfo[env] = jest.fn();
      verifiers[env] = {
        verifyAndDecodeTransaction: jest.fn(),
        verifyAndDecodeNotification: jest.fn(),
      };
    }
    ApiClientMock.mockImplementation((_k, _id, _iss, _bundle, env: Environment) => ({
      getTransactionInfo: getTransactionInfo[env],
    }));
    VerifierMock.mockImplementation((_certs, _online, env: Environment) => verifiers[env]);
  });

  it('returns the production transaction when found', async () => {
    getTransactionInfo[Environment.PRODUCTION].mockResolvedValue({ signedTransactionInfo: 'jws' });
    verifiers[Environment.PRODUCTION].verifyAndDecodeTransaction.mockResolvedValue({
      transactionId: '1',
    });

    const client = new AppleStoreClient(config());
    await expect(client.getVerifiedTransaction('1')).resolves.toEqual({
      transaction: { transactionId: '1' },
      environment: IapEnvironment.PRODUCTION,
    });
    expect(ApiClientMock).toHaveBeenCalledWith(
      'mock signing key',
      'KEY',
      'ISSUER',
      'com.test.app',
      Environment.PRODUCTION,
    );
    expect(VerifierMock).toHaveBeenCalledWith(
      expect.any(Array),
      true,
      Environment.PRODUCTION,
      'com.test.app',
      123,
    );
  });

  it('falls back to sandbox when production does not know the transaction', async () => {
    getTransactionInfo[Environment.PRODUCTION].mockRejectedValue(
      new APIException(404, APIError.TRANSACTION_ID_NOT_FOUND, 'not found'),
    );
    getTransactionInfo[Environment.SANDBOX].mockResolvedValue({ signedTransactionInfo: 'jws' });
    verifiers[Environment.SANDBOX].verifyAndDecodeTransaction.mockResolvedValue({
      transactionId: '2',
    });

    const client = new AppleStoreClient(config());
    await expect(client.getVerifiedTransaction('2')).resolves.toMatchObject({
      environment: IapEnvironment.SANDBOX,
    });
  });

  it('falls back to sandbox when production rejects the key with 401 (app not live yet)', async () => {
    getTransactionInfo[Environment.PRODUCTION].mockRejectedValue(new APIException(401, null));
    getTransactionInfo[Environment.SANDBOX].mockResolvedValue({ signedTransactionInfo: 'jws' });
    verifiers[Environment.SANDBOX].verifyAndDecodeTransaction.mockResolvedValue({
      transactionId: '3',
    });

    const client = new AppleStoreClient(config());
    await expect(client.getVerifiedTransaction('3')).resolves.toMatchObject({
      environment: IapEnvironment.SANDBOX,
    });
  });

  it('answers 502 when both environments reject the key with 401', async () => {
    getTransactionInfo[Environment.PRODUCTION].mockRejectedValue(new APIException(401, null));
    getTransactionInfo[Environment.SANDBOX].mockRejectedValue(new APIException(401, null));

    const client = new AppleStoreClient(config());
    await expect(client.getVerifiedTransaction('3')).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps API errors to HTTP exceptions', async () => {
    const client = new AppleStoreClient(config());

    getTransactionInfo[Environment.PRODUCTION].mockRejectedValue(
      new APIException(404, APIError.TRANSACTION_ID_NOT_FOUND),
    );
    getTransactionInfo[Environment.SANDBOX].mockRejectedValue(
      new APIException(404, APIError.TRANSACTION_ID_NOT_FOUND),
    );
    await expect(client.getVerifiedTransaction('x')).rejects.toBeInstanceOf(NotFoundException);

    getTransactionInfo[Environment.PRODUCTION].mockRejectedValue(new APIException(400, 4000006));
    await expect(client.getVerifiedTransaction('x')).rejects.toBeInstanceOf(BadRequestException);

    getTransactionInfo[Environment.PRODUCTION].mockRejectedValue(new APIException(500, null));
    await expect(client.getVerifiedTransaction('x')).rejects.toBeInstanceOf(BadGatewayException);

    getTransactionInfo[Environment.PRODUCTION].mockRejectedValue(new Error('network'));
    await expect(client.getVerifiedTransaction('x')).rejects.toBeInstanceOf(BadGatewayException);

    getTransactionInfo[Environment.PRODUCTION].mockResolvedValue({});
    await expect(client.getVerifiedTransaction('x')).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps signature failures to 401', async () => {
    verifiers[Environment.SANDBOX].verifyAndDecodeNotification.mockRejectedValue(
      new VerificationException(VerificationStatus.VERIFICATION_FAILURE),
    );
    verifiers[Environment.SANDBOX].verifyAndDecodeTransaction.mockRejectedValue(
      new VerificationException(VerificationStatus.INVALID_ENVIRONMENT),
    );

    const client = new AppleStoreClient(config());
    await expect(client.verifyNotification('bad', IapEnvironment.SANDBOX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(client.verifyTransaction('bad', IapEnvironment.SANDBOX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('decodes a valid notification', async () => {
    verifiers[Environment.PRODUCTION].verifyAndDecodeNotification.mockResolvedValue({
      notificationType: 'TEST',
    });
    const client = new AppleStoreClient(config());
    await expect(client.verifyNotification('ok', IapEnvironment.PRODUCTION)).resolves.toEqual({
      notificationType: 'TEST',
    });
  });

  it('answers 503 when credentials are missing', async () => {
    const client = new AppleStoreClient(config({ APPLE_GAMECENTER_BUNDLE_ID: 'com.test.app' }));
    await expect(client.getVerifiedTransaction('x')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(client.verifyNotification('x', IapEnvironment.PRODUCTION)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    const noBundle = new AppleStoreClient(
      config({ ...FULL_CONFIG, APPLE_GAMECENTER_BUNDLE_ID: undefined }),
    );
    await expect(noBundle.verifyNotification('x', IapEnvironment.SANDBOX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
