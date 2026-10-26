import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { hasRole, type Role } from '@keyless/shared';
import { forbidden, unauthorized } from '../lib/http';
import { Organization } from '../models/Organization';
import { User } from '../models/User';
import { ACCESS_COOKIE, verifyAccessToken } from '../modules/auth/tokens';

/**
 * Resolve the session from the access-token cookie. The user is re-loaded on every request so
 * role changes and removals take effect immediately rather than when the token expires.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const token: unknown = req.cookies?.[ACCESS_COOKIE];
  if (typeof token !== 'string' || !token) return next();

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch (err) {
    req.authError = err instanceof jwt.TokenExpiredError ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
    return next();
  }

  const user = await User.findOne({ _id: claims.sub, orgId: claims.org, active: true });
  if (!user || user.tokenVersion !== claims.tv) {
    req.authError = 'INVALID_TOKEN';
    return next();
  }
  const org = await Organization.findOne({ _id: user.orgId, deletedAt: null });
  if (!org) {
    req.authError = 'INVALID_TOKEN';
    return next();
  }
  req.auth = { user, org, orgId: org._id };
  next();
};

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) {
    throw req.authError === 'TOKEN_EXPIRED'
      ? unauthorized('Session expired', 'TOKEN_EXPIRED')
      : unauthorized();
  }
  next();
}

export function requireVerified(req: Request, _res: Response, next: NextFunction): void {
  if (!authed(req).user.emailVerifiedAt) {
    throw forbidden('Please verify your email address first', 'EMAIL_NOT_VERIFIED');
  }
  next();
}

export function requireRole(minimum: Role): RequestHandler {
  return (req, _res, next) => {
    if (!hasRole(authed(req).user.role, minimum)) throw forbidden();
    next();
  };
}

/** The auth context for a route behind `requireAuth`. */
export function authed(req: Request): NonNullable<Request['auth']> {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
