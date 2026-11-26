import { IsInt, IsOptional, IsString, IsUrl, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Payload for `POST /users/apple`. The Unity client forwards the credential
 * fields produced by GameKit's `GKLocalPlayer.fetchItems(forIdentityVerification:)`:
 *
 *  - `publicKeyUrl`: Apple-hosted URL pointing at the signing certificate.
 *  - `signature`:    Base64 RSA signature over the canonical payload.
 *  - `salt`:         Base64 random salt baked into the signed payload.
 *  - `timestamp`:    Unix timestamp in milliseconds (uint64 big-endian when signed).
 *  - `playerId`:     GameKit player/teamPlayer id. Only trusted after the
 *                    server verifies the signature over the full payload.
 *  - `name` (optional): preferred display name.
 *
 * The server validates the signature with the bundle id from
 * `APPLE_GAMECENTER_BUNDLE_ID` — the bundle id is NEVER taken from the client.
 */
export class CreateUserAppleDto {
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  @MaxLength(2048)
  publicKeyUrl!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(4096)
  signature!: string;

  @IsString()
  @MinLength(4)
  @MaxLength(1024)
  salt!: string;

  @IsInt()
  @Min(0)
  timestamp!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  playerId!: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(32)
  name?: string;
}
