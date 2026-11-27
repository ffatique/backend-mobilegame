import { IsInt, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export type VerifyStatus = 'granted' | 'duplicate' | 'pending' | 'refunded';

export interface VerifyPurchaseResponse {
  status: VerifyStatus;
  productId: string;
  gemsGranted: number;
  purchaseCredit?: number;
  gems: number;
  coins: number;
}

export class AppleVerifyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  transactionId!: string;
}

export class GoogleVerifyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  productId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  purchaseToken!: string;
}

export class AppleNotificationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100_000)
  signedPayload!: string;
}

/** Pub/Sub push envelope. `message` stays a plain object so Google's extra fields aren't rejected. */
export class PubSubPushDto {
  @IsObject()
  message!: { data?: unknown; messageId?: unknown };

  @IsOptional()
  @IsString()
  @MaxLength(512)
  subscription?: string;

  @IsOptional()
  @IsInt()
  deliveryAttempt?: number;
}
