import { AuthProviderType } from '@prisma/client';

/**
 * Result of a successful identity-provider verification.
 * `providerUserId` is the stable identifier returned by the provider
 * (e.g. Google Play Games player id, Apple Game Center playerID/teamPlayerID).
 */
export interface VerifiedProviderIdentity {
  provider: AuthProviderType;
  providerUserId: string;
  /** Optional display name returned by the provider, used as a default username. */
  displayName?: string;
}

/**
 * Credential payload accepted by an identity-provider verifier. The shape
 * depends on the provider:
 *  - Google Play Games: a `string` (server auth code).
 *  - Apple Game Center: an object with `{ publicKeyUrl, signature, salt,
 *    timestamp, playerId }` returned by `GKLocalPlayer.fetchItems(...)`.
 * Each verifier is responsible for validating the shape of its own input.
 */
export type ProviderCredential = string | Record<string, unknown>;

/**
 * Contract implemented by every identity provider verifier. Implementations must throw `UnauthorizedException` on any
 * failure to keep callers simple.
 */
export interface ProviderVerifier {
  readonly provider: AuthProviderType;
  verify(credential: ProviderCredential): Promise<VerifiedProviderIdentity>;
}
