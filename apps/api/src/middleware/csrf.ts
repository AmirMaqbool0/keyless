import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { CSRF_COOKIE, CSRF_HEADER } from '@keyless/shared';
import { isProd } from '@keyless/core/config/env';
import { forbidden } from '@keyless/core/lib/http';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF protection. A readable cookie holds a random token; state-changing requests
 * must echo it in a header, which a cross-site page cannot read. Combined with SameSite=Lax auth
 * cookies. Provider webhooks (M3+) are mounted before this middleware with their own signatures.
 */
export const csrf: RequestHandler = (req, res, next) => {
  let token: unknown = req.cookies?.[CSRF_COOKIE];
  if (typeof token !== 'string' || token.length < 20) {
    token = crypto.randomBytes(24).toString('base64url');
    res.cookie(CSRF_COOKIE, token, { httpOnly: false, secure: isProd, sameSite: 'lax', path: '/' });
    // Let a brand-new client make its first state-changing call without a round trip.
    res.setHeader(CSRF_HEADER, token as string);
  }
  if (SAFE_METHODS.has(req.method)) return next();

  const header = req.get(CSRF_HEADER);
  const a = Buffer.from(header ?? '');
  const b = Buffer.from(token as string);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw forbidden('Invalid or missing CSRF token', 'CSRF_FAILED');
  }
  next();
};
