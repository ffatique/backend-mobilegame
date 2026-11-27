import { Controller, Get, ServiceUnavailableException, HttpCode, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SkipThrottle } from '@nestjs/throttler';

/**
 * Tiny liveness endpoint. Doesn't touch the database, isn't throttled, and
 * never logs PII — perfect for Vercel/uptime monitor health checks. Lets
 * legitimate `GET /` and `GET /health` traffic respond instantly while
 * scanner traffic against random paths still 404s without hitting a guard.
 */
@SkipThrottle()
@Controller()
export class HealthController {
  constructor(private readonly db: PrismaService) {}
  @Get('health/bait')
  async refillHealth() {
    const [row] = await this.db.$queryRaw<{ ok: boolean }[]>`SELECT EXISTS (
      SELECT 1 FROM pier_refills WHERE ran_at >= date_trunc('day', (now() AT TIME ZONE 'UTC')-interval '2 hours') AT TIME ZONE 'UTC'
    ) AS ok`;
    if (!row.ok) throw new ServiceUnavailableException('Daily refill missing');
    return { status: 'ok' };
  }
  @Get()
  @HttpCode(HttpStatus.OK)
  root(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('health')
  @HttpCode(HttpStatus.OK)
  health(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: process.uptime() };
  }
}
