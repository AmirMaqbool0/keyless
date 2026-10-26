import pino from 'pino';
import { env, isProd } from '../config/env';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
  ...(isProd || env.NODE_ENV === 'test'
    ? {}
    : {
        transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } },
      }),
});
