import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express, { Express } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';

type Application = { app: INestApplication; expressApp: Express };
let startup: Promise<Application> | undefined;

// Concurrent cold-start requests share a single application and database pool.
export function bootstrap(): Promise<Application> {
  startup ??= createApplication().catch((error) => {
    startup = undefined;
    throw error;
  });
  return startup;
}

async function createApplication(): Promise<Application> {
  const expressApp = express();
  const app = await NestFactory.create(AppModule, new ExpressAdapter(expressApp), {
    logger: ['error', 'warn', 'log'],
  });

  const config = app.get(ConfigService);

  app.use(helmet());

  const corsOrigins = config.get<string[]>('CORS_ORIGINS') ?? [];
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  await app.init();

  return { app, expressApp };
}

async function main(): Promise<void> {
  const { app } = await bootstrap();
  const port = app.get(ConfigService).get<number>('PORT') ?? 3000;
  await app.listen(port);
  new Logger('Bootstrap').log(`My Little Pier API listening on :${port}`);
}

// Only auto-run when invoked directly (not when imported by the Vercel handler).
if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to bootstrap application', err);
    process.exit(1);
  });
}
