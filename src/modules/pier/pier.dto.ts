import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
class CaptureDto {
  @IsInt() @Min(0) @Max(5) species!: number;
  @IsBoolean() rare!: boolean;
  @IsInt() @Min(1) @Max(125) length!: number;
  @IsInt() @Min(1) @Max(12500) grams!: number;
  @IsIn(['S', 'M', 'L', 'XL']) size!: string;
  @IsOptional() @IsISO8601({ strict: true }) caughtAt?: string;
}
export class SaveDto {
  @IsUUID() mutation!: string;
  @IsInt() @Min(0) @Max(2147483646) revision!: number;
  @IsInt() @Min(0) @Max(1) spend!: number;
  @IsString() @MinLength(1) @MaxLength(16000) snapshot!: string;
  @IsOptional() @ValidateNested() @Type(() => CaptureDto) capture?: CaptureDto;
}
export class FriendDto {
  @IsIn(['send', 'accept', 'decline']) action!: string;
}
