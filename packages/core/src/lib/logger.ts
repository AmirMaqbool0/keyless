import { createRequire } from 'node:module';
import pino, { type TransportSingleOptions } from 'pino';
import { env, isProd } from '../config/env';

const require = createRequire(import.meta.url);

let transport: TransportSingleOptions | undefined;
if (!isProd && env.NODE_ENV !== 'test') {
  try {
    require.resolve('pino-pretty');
    transport = { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } };
  } catch {
    // Fall back to standard JSON stream if pino-pretty is not installed
  }
}

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
  ...(transport ? { transport } : {}),
});
