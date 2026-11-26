import { IsString, Length } from 'class-validator';

export class BuyItemDto {
  @IsString()
  @Length(1, 64)
  itemId!: string;
}
