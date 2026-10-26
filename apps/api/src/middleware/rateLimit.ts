import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '@keyless/core/config/env';

// In-memory store for now; switch to a Redis store when the API runs more than one instance (M3+).
const passthrough: RequestHandler = (_req, _res, next) => next();

function limiter(windowMs: number, limit: number): RequestHandler {
  if (env.RATE_LIMIT_DISABLED) return passthrough;
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' },
    },
  });
}

/** Sign-in, sign-up, password reset: slow down credential stuffing. */
export const authLimiter = limiter(15 * 60 * 1000, 30);
/** General API ceiling per IP. */
export const apiLimiter = limiter(60 * 1000, 600);
