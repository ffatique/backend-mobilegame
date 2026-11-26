import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload for `POST /users/google`. The Unity client sends:
 *  - `authToken`: a `serverAuthCode` obtained from Google Play Games Services
 *    (configured against `GOOGLE_PLAY_GAMES_CLIENT_ID`). NEVER the raw
 *    `playerId` — that is not a credential.
 *  - `name` (optional): preferred display name; defaults to a generated one.
 */
export class CreateUserGoogleDto {
  @IsString()
  @MinLength(8)
  @MaxLength(4096)
  authToken!: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(32)
  name?: string;
}
