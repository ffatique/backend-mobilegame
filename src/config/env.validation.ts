import { z } from 'zod';

/**
 * Environment schema. Validated at boot in `main.ts` so a misconfigured
 * deployment fails fast instead of erroring per-request later.
 */
const optionalSetting = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().nonnegative().default(3000),

  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    ),

  DATABASE_URL: z.string().url(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('1h'),
  REFRESH_TOKEN_EXPIRES_IN_DAYS: z.coerce.number().int().positive().default(60),

  GOOGLE_PLAY_GAMES_CLIENT_ID: z.string().optional(),
  GOOGLE_PLAY_GAMES_CLIENT_SECRET: z.string().optional(),

  APPLE_GAMECENTER_BUNDLE_ID: z.string().optional(),
  APPLE_IAP_KEY_ID: z.string().optional(),
  APPLE_IAP_ISSUER_ID: z.string().optional(),
  APPLE_IAP_PRIVATE_KEY_BASE64: z.string().optional(),
  APPLE_APP_ID: optionalSetting(z.coerce.number().int().positive()),
  GOOGLE_PLAY_PACKAGE_NAME: z.string().optional(),
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64: z.string().optional(),
  GOOGLE_RTDN_AUDIENCE: optionalSetting(z.string().url()),
  GOOGLE_RTDN_PUSH_SERVICE_ACCOUNT: optionalSetting(z.string().email()),
  IAP_CREDIT_SANDBOX: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ADMOB_REWARDED_AD_UNITS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}
