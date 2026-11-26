import type { IncomingMessage, ServerResponse } from 'http';
import { bootstrap } from '../src/main';

/**
 * Vercel serverless entry point. Reuses the cached Nest app instance across
 * invocations (warm starts) and delegates the raw Node request/response to
 * the underlying Express adapter.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { expressApp } = await bootstrap();
  expressApp(req as never, res as never);
}
