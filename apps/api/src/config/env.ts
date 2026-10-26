import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Load the nearest .env walking up from cwd (the repo root holds one shared .env). */
function loadDotEnv(): void {
  let dir = process.cwd();
  for (;;) {
    const file = path.join(dir, '.env');
    if (fs.existsSync(file)) {
      process.loadEnvFile(file);
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

if (process.env.NODE_ENV !== 'test') loadDotEnv();

const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.url().default('http://localhost:5173'),
  API_URL: z.url().default('http://localhost:4000'),
  MONGO_URI: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: base64Key32,
  EMAIL_PROVIDER: z.enum(['console']).default('console'),
  EMAIL_FROM: z.string().default('Keyless <no-reply@keyless.local>'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RATE_LIMIT_DISABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:\n' + z.prettifyError(parsed.error));
  console.error('Copy .env.example to .env and fill in the required values.');
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
