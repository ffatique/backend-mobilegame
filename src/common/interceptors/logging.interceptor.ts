import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';

/** Logs request timing and status without recording credentials. */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<{
      method?: string;
      originalUrl?: string;
      url?: string;
      user?: { id?: string };
    }>();
    const res = http.getResponse<{ statusCode?: number }>();

    const method = req.method ?? 'UNKNOWN';
    const path = (req.originalUrl ?? req.url ?? 'unknown').split('?')[0];
    const startedAt = Date.now();

    const userTag = (): string => (req.user?.id ? ` user=${req.user.id}` : '');

    return next.handle().pipe(
      tap({
        next: () => {
          const ms = Date.now() - startedAt;
          const status = res.statusCode ?? 200;
          this.logger.log(`${method} ${path} ${status} ${ms}ms${userTag()}`);
        },
        error: (err: unknown) => {
          const ms = Date.now() - startedAt;
          const status =
            typeof (err as { status?: number })?.status === 'number'
              ? (err as { status: number }).status
              : 500;
          const message = err instanceof Error ? err.message : 'Unknown error';
          this.logger.warn(`${method} ${path} ${status} ${ms}ms${userTag()} error="${message}"`);
        },
      }),
    );
  }
}
