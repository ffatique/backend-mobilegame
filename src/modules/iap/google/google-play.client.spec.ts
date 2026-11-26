import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as google from '@googleapis/androidpublisher';
import { GooglePlayClient } from './google-play.client';

jest.mock('@googleapis/androidpublisher', () => ({
  auth: { GoogleAuth: jest.fn() },
  androidpublisher: jest.fn(),
}));

const FULL_CONFIG: Record<string, unknown> = {
  GOOGLE_PLAY_PACKAGE_NAME: 'com.test.app',
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64: Buffer.from('{"client_email":"a@b.c"}').toString(
    'base64',
  ),
};

function config(values: Record<string, unknown> = FULL_CONFIG): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

describe('GooglePlayClient', () => {
  const get = jest.fn();
  const consume = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (google.androidpublisher as unknown as jest.Mock).mockReturnValue({
      purchases: { products: { get, consume } },
    });
  });

  it('fetches a product purchase with the configured package', async () => {
    get.mockResolvedValue({ data: { purchaseState: 0 } });
    const client = new GooglePlayClient(config());

    await expect(client.getProductPurchase('sku', 'tok')).resolves.toEqual({ purchaseState: 0 });
    expect(get).toHaveBeenCalledWith({
      packageName: 'com.test.app',
      productId: 'sku',
      token: 'tok',
    });
    expect(google.auth.GoogleAuth).toHaveBeenCalledWith({
      credentials: { client_email: 'a@b.c' },
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
  });

  it('consumes a purchase', async () => {
    consume.mockResolvedValue({});
    const client = new GooglePlayClient(config());
    await client.consume('sku', 'tok');
    expect(consume).toHaveBeenCalledWith({
      packageName: 'com.test.app',
      productId: 'sku',
      token: 'tok',
    });
  });

  it('maps invalid tokens to 400 and other failures to 502', async () => {
    const client = new GooglePlayClient(config());

    get.mockRejectedValueOnce({ response: { status: 404 } });
    await expect(client.getProductPurchase('sku', 'tok')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    get.mockRejectedValueOnce({ code: 410 });
    await expect(client.getProductPurchase('sku', 'tok')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    consume.mockRejectedValueOnce({ status: 503 });
    await expect(client.consume('sku', 'tok')).rejects.toBeInstanceOf(BadGatewayException);

    get.mockRejectedValueOnce(new Error('network'));
    await expect(client.getProductPurchase('sku', 'tok')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('answers 503 when not configured', async () => {
    const noKey = new GooglePlayClient(config({ GOOGLE_PLAY_PACKAGE_NAME: 'com.test.app' }));
    await expect(noKey.getProductPurchase('sku', 'tok')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    const noPackage = new GooglePlayClient(config({}));
    expect(() => noPackage.packageName).toThrow(ServiceUnavailableException);
  });
});
