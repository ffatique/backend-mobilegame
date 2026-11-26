import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class LogoutDto {
  /**
   * The refresh token of the current device. When present, it (and only it)
   * is revoked. The access token associated with this session is left to
   * expire naturally — JWT revocation is out of scope for the MVP.
   */
  @IsOptional()
  @IsString()
  @MinLength(32)
  @MaxLength(512)
  refreshToken?: string;

  /**
   * When true, every refresh token still active for the authenticated user
   * is revoked. Use for "sign out everywhere".
   */
  @IsOptional()
  @IsBoolean()
  allDevices?: boolean;
}
