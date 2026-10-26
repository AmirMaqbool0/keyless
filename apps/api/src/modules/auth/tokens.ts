import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env, isProd } from '@keyless/core/config/env';
import { hashToken, randomToken } from '@keyless/core/lib/tokens';
import { Session } from '@keyless/core/models/Session';
import type { UserDoc } from '@keyless/core/models/User';

export const ACCESS_COOKIE = 'keyless_at';
export const REFRESH_COOKIE = 'keyless_rt';
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_SECONDS = 5 * 60;
/** A just-rotated refresh token presented again within this window is a benign race (two tabs). */
const ROTATION_GRACE_MS = 30 * 1000;
const ISSUER = 'keyless';

type AccessClaims = { sub: string; org: string; tv: number; typ: 'access' };
type ChallengeClaims = { sub: string; typ: '2fa' };

export function signAccessToken(user: UserDoc): string {
  const claims: AccessClaims = {
    sub: user._id.toString(),
    org: user.orgId.toString(),
    tv: user.tokenVersion,
    typ: 'access',
  };
  return jwt.sign(claims, env.JWT_SECRET, { expiresIn: ACCESS_TTL_SECONDS, issuer: ISSUER });
}

export function verifyAccessToken(token: string): AccessClaims {
  const payload = jwt.verify(token, env.JWT_SECRET, { issuer: ISSUER });
  if (typeof payload === 'string' || payload.typ !== 'access')
    throw new jwt.JsonWebTokenError('wrong token type');
  return payload as unknown as AccessClaims;
}

/** Short-lived token proving the password step passed; exchanged with a TOTP code. */
export function signChallengeToken(user: UserDoc): string {
  const claims: ChallengeClaims = { sub: user._id.toString(), typ: '2fa' };
  return jwt.sign(claims, env.JWT_SECRET, { expiresIn: CHALLENGE_TTL_SECONDS, issuer: ISSUER });
}

export function verifyChallengeToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { issuer: ISSUER });
    if (typeof payload === 'string' || payload.typ !== '2fa' || typeof payload.sub !== 'string')
      return null;
    return payload.sub;
  } catch {
    return null;
  }
}

async function createSessionRecord(user: UserDoc, req: Request, familyId: string): Promise<string> {
  const token = randomToken();
  await Session.create({
    orgId: user.orgId,
    userId: user._id,
    familyId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    userAgent: req.get('user-agent')?.slice(0, 300),
    ip: req.ip,
  });
  return token;
}

/** Start a new login session and set both cookies. */
export async function issueSession(user: UserDoc, req: Request, res: Response): Promise<void> {
  const refresh = await createSessionRecord(user, req, crypto.randomUUID());
  setAuthCookies(res, signAccessToken(user), refresh);
}

export type RotateResult =
  | { ok: true; userId: string; orgId: string; issue: (user: UserDoc) => Promise<void> }
  | { ok: false };

/** Validate a refresh token and rotate it. Reuse of a revoked token revokes the whole family. */
export async function rotateSession(
  token: string,
  req: Request,
  res: Response,
): Promise<RotateResult> {
  const session = await Session.findOne({ tokenHash: hashToken(token) }).setOptions({
    skipTenant: true,
  });
  if (!session || session.expiresAt < new Date()) return { ok: false };

  if (session.revokedAt) {
    const benignRace =
      session.rotatedAt && Date.now() - session.rotatedAt.getTime() < ROTATION_GRACE_MS;
    if (!benignRace) {
      await Session.updateMany(
        { orgId: session.orgId, familyId: session.familyId, revokedAt: null },
        { revokedAt: new Date() },
      );
    }
    return { ok: false };
  }

  const now = new Date();
  session.revokedAt = now;
  session.rotatedAt = now;
  await session.save();

  return {
    ok: true,
    userId: session.userId.toString(),
    orgId: session.orgId.toString(),
    issue: async (user) => {
      const refresh = await createSessionRecord(user, req, session.familyId);
      setAuthCookies(res, signAccessToken(user), refresh);
    },
  };
}

export async function revokeSessionByToken(token: string): Promise<void> {
  await Session.updateOne({ tokenHash: hashToken(token) }, { revokedAt: new Date() }).setOptions({
    skipTenant: true,
  });
}

export async function revokeAllSessions(user: UserDoc): Promise<void> {
  await Session.updateMany(
    { orgId: user.orgId, userId: user._id, revokedAt: null },
    { revokedAt: new Date() },
  );
}

const baseCookie = { httpOnly: true, secure: isProd, sameSite: 'lax' as const };

export function setAuthCookies(res: Response, access: string, refresh: string): void {
  res.cookie(ACCESS_COOKIE, access, {
    ...baseCookie,
    path: '/',
    maxAge: ACCESS_TTL_SECONDS * 1000,
  });
  res.cookie(REFRESH_COOKIE, refresh, { ...baseCookie, path: '/api/auth', maxAge: REFRESH_TTL_MS });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie, path: '/api/auth' });
}
