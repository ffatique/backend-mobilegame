import {
  Body,
  HttpException,
  Controller,
  DefaultValuePipe,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual, createHash } from 'node:crypto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PierService } from './pier.service';
import {
  CastDto,
  FinishDto,
  ActionDto,
  FriendDto,
  BaitPurchaseDto,
  AdTicketDto,
  WardrobeDto,
} from './pier.dto';

@Controller('pier')
@UseGuards(JwtAuthGuard)
export class PierController {
  constructor(private readonly pier: PierService) {}
  @Get('state') state(@CurrentUser() u: { id: string }) {
    return this.pier.state(u.id);
  }
  @Post('state') legacySave() {
    throw new HttpException('Update My Little Pier to continue account fishing', 426);
  }
  @Get('school') school(@CurrentUser() u: { id: string }) {
    return this.pier.school(u.id);
  }
  @Post('cast') cast(@CurrentUser() u: { id: string }, @Body() dto: CastDto) {
    return this.pier.cast(u.id, dto);
  }
  @Post('finish') finish(@CurrentUser() u: { id: string }, @Body() dto: FinishDto) {
    return this.pier.finish(u.id, dto);
  }
  @Post('action') action(@CurrentUser() u: { id: string }, @Body() dto: ActionDto) {
    return this.pier.action(u.id, dto);
  }
  @Post('wardrobe') wardrobe(@CurrentUser() u: { id: string }, @Body() dto: WardrobeDto) {
    return this.pier.wardrobe(u.id, dto);
  }
  @Get('bait/offer') baitOffer(@CurrentUser() u: { id: string }) {
    return this.pier.baitOffer(u.id);
  }
  @Post('bait/purchase') buy(@CurrentUser() u: { id: string }, @Body() dto: BaitPurchaseDto) {
    return this.pier.baitOperation(u.id, dto.key, 'purchase');
  }
  @Post('bait/status') receipt(@CurrentUser() u: { id: string }, @Body() dto: BaitPurchaseDto) {
    return this.pier.baitReceipt(u.id, dto.key);
  }
  @Post('bait/ad') reserve(@CurrentUser() u: { id: string }, @Body() dto: AdTicketDto) {
    return this.pier.baitOperation(u.id, dto.key, 'ad', dto.milestone);
  }
  @Get('history') history(
    @CurrentUser() u: { id: string },
    @Query('before', new DefaultValuePipe(2147483647), ParseIntPipe) before: number,
  ) {
    return this.pier.history(u.id, before);
  }
  @Get('stats') stats(@CurrentUser() u: { id: string }) {
    return this.pier.stats(u.id);
  }
  @Get('players') search(@CurrentUser() u: { id: string }, @Query('q') q = '') {
    return this.pier.search(u.id, q);
  }
  @Get('friends') friends(@CurrentUser() u: { id: string }) {
    return this.pier.friends(u.id);
  }
  @Post('friends/:id') friend(
    @CurrentUser() u: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FriendDto,
  ) {
    return this.pier.friend(u.id, id, dto.action);
  }
}

@Controller('jobs')
export class PierJobController {
  constructor(
    private readonly pier: PierService,
    private readonly config: ConfigService,
  ) {}
  @Get('bait') refill(@Headers('authorization') auth?: string) {
    const secret = this.config.get<string>('CRON_SECRET');
    const hash = (s: string) => createHash('sha256').update(s).digest();
    if (!secret || !auth || !timingSafeEqual(hash(auth), hash('Bearer ' + secret)))
      throw new UnauthorizedException();
    return this.pier.refill();
  }
}
