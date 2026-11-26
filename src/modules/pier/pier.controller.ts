import {
  Body,
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
import { SaveDto, FriendDto } from './pier.dto';

@Controller('pier')
@UseGuards(JwtAuthGuard)
export class PierController {
  constructor(private readonly pier: PierService) {}
  @Get('state') state(@CurrentUser() u: { id: string }) {
    return this.pier.state(u.id);
  }
  @Post('state') save(@CurrentUser() u: { id: string }, @Body() dto: SaveDto) {
    return this.pier.save(u.id, dto);
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
