import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
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
