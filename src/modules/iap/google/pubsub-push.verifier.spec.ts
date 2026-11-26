import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { PubSubPushVerifier } from './pubsub-push.verifier';

jest.mock('google-auth-library', () => ({ OAuth2Client: jest.fn() }));

const AUDIENCE = 'https://api.test/iap/google/rtdn';
const EMAIL = 'push@test.iam.gserviceaccount.com';

function config(values: Record<string, unknown>): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

describe('PubSubPushVerifier', () => {
  const verifyIdToken = jest.fn();
  let verifier: PubSubPushVerifier;

  beforeEach(() => {
    verifyIdToken.mockReset();
    (OAuth2Client as unknown as jest.Mock).mockImplementation(() => ({ verifyIdToken }));
    verifier = new PubSubPushVerifier(
      config({ GOOGLE_RTDN_AUDIENCE: AUDIENCE, GOOGLE_RTDN_PUSH_SERVICE_ACCOUNT: EMAIL }),
    );
  });

  function ticket(payload: Record<string, unknown> | undefined) {
    verifyIdToken.mockResolvedValue({ getPayload: () => payload });
  }

  it('accepts a token from the configured service account and audience', async () => {
    ticket({ email: EMAIL.toUpperCase(), email_verified: true });
    await expect(verifier.verify('Bearer abc')).resolves.toBeUndefined();
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: 'abc', audience: AUDIENCE });
  });

  it('rejects a missing bearer token', async () => {
    await expect(verifier.verify(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(verifier.verify('Basic abc')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an invalid token or wrong audience', async () => {
    verifyIdToken.mockRejectedValue(new Error('Wrong recipient'));
    await expect(verifier.verify('Bearer abc')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects tokens from other or unverified accounts', async () => {
    ticket({ email: 'attacker@evil.com', email_verified: true });
    await expect(verifier.verify('Bearer abc')).rejects.toBeInstanceOf(UnauthorizedException);

    ticket({ email: EMAIL, email_verified: false });
    await expect(verifier.verify('Bearer abc')).rejects.toBeInstanceOf(UnauthorizedException);

    ticket(undefined);
    await expect(verifier.verify('Bearer abc')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('answers 503 when not configured', async () => {
    const unconfigured = new PubSubPushVerifier(config({}));
    await expect(unconfigured.verify('Bearer abc')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
