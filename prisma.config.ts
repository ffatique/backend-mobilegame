import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 configuration. The `datasource` block in `schema.prisma` only
 * declares the provider; the connection URL lives here.
 *
 * `DATABASE_URL` is read directly from `process.env` (instead of `env()`) so
 * commands that don't need a database — most notably `prisma generate` during
 * the Vercel build — succeed when the variable is absent. Commands that DO
 * need the URL (`prisma migrate`, `prisma db push`, `prisma studio`) will
 * fail with a clear "missing connection string" error from the engine.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
