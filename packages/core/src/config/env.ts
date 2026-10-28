import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Directory of the nearest .env walking up from cwd (the repo root holds one shared .env). */
function findEnvDir(): string | undefined {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, '.env'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const envDir = findEnvDir();
if (process.env.NODE_ENV !== 'test' && envDir) process.loadEnvFile(path.join(envDir, '.env'));
/** Repo root in development (where .env lives); cwd otherwise. */
const rootDir = envDir ?? process.cwd();

const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded');

/** Empty strings in .env mean "not set". */
const optional = z
  .string()
  .optional()
  .transform((v) => v || undefined);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z
    .string()
    .optional()
    .transform((v) => {
      let raw = (v || process.env.RENDER_EXTERNAL_URL || 'http://localhost:5173').trim();
      raw = raw.replace(/^["']|["']$/g, '').trim();
      if (!/^https?:\/\//i.test(raw)) {
        raw = `https://${raw}`;
      }
      return raw.replace(/\/+$/, '');
    })
    .pipe(z.string().url()),
  API_URL: z
    .string()
    .optional()
    .transform((v) => {
      let raw = (v || process.env.RENDER_EXTERNAL_URL || 'http://localhost:4000').trim();
      raw = raw.replace(/^["']|["']$/g, '').trim();
      if (!/^https?:\/\//i.test(raw)) {
        raw = `https://${raw}`;
      }
      return raw.replace(/\/+$/, '');
    })
    .pipe(z.string().url()),
  MONGO_URI: z
    .string()
    .optional()
    .transform(
      (v) =>
        (v || process.env.MONGODB_URI || process.env.DATABASE_URL || '')
          .trim()
          .replace(/^["']|["']$/g, ''),
    )
    .refine(
      (v) => v.startsWith('mongodb://') || v.startsWith('mongodb+srv://'),
      'MONGO_URI must be provided and start with "mongodb://" or "mongodb+srv://"',
    ),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: base64Key32,
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z
    .string()
    .default('.data/files')
    .transform((p) => path.resolve(rootDir, p)),
  S3_ENDPOINT: optional,
  S3_REGION: z.string().default('eu-west-2'),
  S3_BUCKET: optional,
  S3_ACCESS_KEY: optional,
  S3_SECRET_KEY: optional,
  // Jobs: "mongo" needs nothing extra; "bullmq" needs Redis (e.g. Upstash free tier, Memurai).
  QUEUE_DRIVER: z.enum(['mongo', 'bullmq']).default('mongo'),
  REDIS_URL: optional,
  INBOUND_EMAIL_DOMAIN: z.string().default('in.keyless.local'),
  INBOUND_WEBHOOK_SECRET: optional,
  MAILBOX_SYNC_INTERVAL_SEC: z.coerce.number().int().min(30).default(120),
  MS_CLIENT_ID: optional,
  MS_CLIENT_SECRET: optional,
  MS_TENANT: z.string().default('common'),
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  LLM_PROVIDER: z.enum(['mock', 'anthropic', 'agentrouter']).default('mock'),
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_BASE_URL: optional,
  AGENTROUTER_API_KEY: optional,
  AGENTROUTER_BASE_URL: optional,
  LLM_MODEL_CLASSIFY: optional,
  LLM_MODEL_EXTRACTION: optional,
  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  EMAIL_PROVIDER_API_KEY: optional,
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

if (isProd && !env.INBOUND_WEBHOOK_SECRET) {
  console.error('INBOUND_WEBHOOK_SECRET is required in production.');
  process.exit(1);
}

function isLoopback(val: string): boolean {
  return /(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(val);
}

/**
 * Resolves the application base URL (e.g. "https://keyless-61vb.onrender.com").
 * Prioritizes configured production/external APP_URL or RENDER_EXTERNAL_URL,
 * with dynamic detection from request headers (origin / x-forwarded-host) when available,
 * falling back safely to env.APP_URL.
 */
export function getAppBaseUrl(req?: {
  get?: (name: string) => string | undefined;
  protocol?: string;
}): string {
  if (env.APP_URL && !isLoopback(env.APP_URL)) {
    return env.APP_URL;
  }
  if (req && typeof req.get === 'function') {
    const origin = req.get('origin');
    if (origin && !isLoopback(origin)) {
      return origin.replace(/\/+$/, '');
    }
    const forwardedHost = req.get('x-forwarded-host') || req.get('host');
    const forwardedProto = req.get('x-forwarded-proto') || req.protocol || 'https';
    if (forwardedHost && !isLoopback(forwardedHost)) {
      return `${forwardedProto}://${forwardedHost}`.replace(/\/+$/, '');
    }
  }
  return env.APP_URL;
}
