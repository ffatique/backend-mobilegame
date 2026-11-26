import { randomUUID } from 'node:crypto';

// The route suites mock Prisma and the store clients.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://localhost/pier_test';
process.env.JWT_SECRET = randomUUID();
process.env.ADMOB_REWARDED_AD_UNITS = '2747237135';
process.env.IAP_CREDIT_SANDBOX = 'true';
