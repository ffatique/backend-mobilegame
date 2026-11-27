import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
export class FriendDto {
  @IsIn(['send', 'accept', 'decline']) action!: string;
}

export class BaitPurchaseDto {
  @IsUUID() key!: string;
}
export class AdTicketDto extends BaitPurchaseDto {
  @IsInt() @Min(5) @Max(2147483647) milestone!: number;
}

export const wardrobePrices = { overalls: 5, shirt: 3, hat: 4 } as const;
export class WardrobeDto {
  @IsIn(Object.keys(wardrobePrices)) item!: keyof typeof wardrobePrices;
  @IsIn(['buy', 'equip', 'remove']) action!: 'buy' | 'equip' | 'remove';
}

export class CastDto extends BaitPurchaseDto {
  @IsInt() @Min(0) @Max(2) station!: number;
  @IsOptional() @IsUUID() fishId?: string;
}
export class FinishDto extends BaitPurchaseDto {
  @IsUUID() attempt!: string;
  @IsIn(['caught', 'escaped', 'empty', 'abandoned']) outcome!:
    | 'caught'
    | 'escaped'
    | 'empty'
    | 'abandoned';
}
export class ActionDto extends BaitPurchaseDto {
  @IsInt() @Min(0) revision!: number;
  @IsIn([
    'sell',
    'basket',
    'rocks',
    'point',
    'rod',
    'station0',
    'station1',
    'station2',
    'daily',
    'read',
    'deliver',
  ])
  action!: string;
}
