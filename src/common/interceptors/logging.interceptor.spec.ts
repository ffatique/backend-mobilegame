import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { of, throwError, lastValueFrom } from 'rxjs';
import { LoggingInterceptor } from './logging.interceptor';

function makeContext(req: unknown, res: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
}

describe('LoggingInterceptor', () => {
  let interceptor: LoggingInterceptor;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    interceptor = new LoggingInterceptor();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs a successful request with method, path, status and user', async () => {
    const ctx = makeContext(
      { method: 'POST', originalUrl: '/shop/buy', user: { id: 'user-123' } },
      { statusCode: 200 },
    );
    const next: CallHandler = { handle: () => of({ ok: true }) };

    await lastValueFrom(interceptor.intercept(ctx, next));

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain('POST /shop/buy 200');
    expect(line).toContain('user=user-123');
  });

  it('omits the user tag for anonymous requests', async () => {
    const ctx = makeContext({ method: 'GET', url: '/health' }, { statusCode: 200 });
    const next: CallHandler = { handle: () => of('pong') };

    await lastValueFrom(interceptor.intercept(ctx, next));

    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain('GET /health 200');
    expect(line).not.toContain('user=');
  });

  it('warns with the error status and message on failure', async () => {
    const ctx = makeContext(
      { method: 'POST', originalUrl: '/shop/buy', user: { id: 'user-9' } },
      { statusCode: 200 },
    );
    const error = Object.assign(new Error('Insufficient funds'), {
      status: 400,
    });
    const next: CallHandler = { handle: () => throwError(() => error) };

    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(error);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = warnSpy.mock.calls[0][0] as string;
    expect(line).toContain('POST /shop/buy 400');
    expect(line).toContain('user=user-9');
    expect(line).toContain('Insufficient funds');
  });

  it('defaults to status 500 when the error carries no status', async () => {
    const ctx = makeContext({ method: 'GET', url: '/boom' }, {});
    const next: CallHandler = {
      handle: () => throwError(() => new Error('boom')),
    };

    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toThrow('boom');

    const line = warnSpy.mock.calls[0][0] as string;
    expect(line).toContain('GET /boom 500');
  });
});
