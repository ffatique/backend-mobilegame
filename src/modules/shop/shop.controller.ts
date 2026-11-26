import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { catalog } from './catalog';
import { BuyItemDto } from './dto/buy-item.dto';
import { ShopService } from './shop.service';

@Controller('shop')
@UseGuards(JwtAuthGuard)
export class ShopController {
  constructor(private readonly shop: ShopService) {}

  @Get()
  list() {
    return catalog;
  }

  @Post('buy')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  buy(@CurrentUser() user: { id: string }, @Body() dto: BuyItemDto) {
    return this.shop.buy(user.id, dto.itemId);
  }
}
