import argon2 from 'argon2';
import { Router } from 'express';
import {
  acceptInviteSchema,
  disableTwoFactorSchema,
  enableTwoFactorSchema,
  forgotPasswordSchema,
  loginSchema,
  loginTwoFactorSchema,
  resetPasswordSchema,
  signupSchema,
  tokenSchema,
  type LoginResponse,
  type MeResponse,
} from '@keyless/shared';
import { audit } from '@keyless/core/lib/audit';
import { badRequest, notFound, param, unauthorized, validate } from '@keyless/core/lib/http';
import type { Mailer } from '@keyless/core/lib/mailer';
import { authed, requireAuth } from '../../middleware/auth';
import { authLimiter } from '../../middleware/rateLimit';
import { getAppBaseUrl } from '@keyless/core/config/env';
import { Organization } from '@keyless/core/models/Organization';
import { User, type UserDoc } from '@keyless/core/models/User';
import { toOrgDto, toUserDto } from '../dto';
import { createAuthService } from './service';
import {
  REFRESH_COOKIE,
  clearAuthCookies,
  issueSession,
  revokeSessionByToken,
  rotateSession,
  signChallengeToken,
  verifyChallengeToken,
} from './tokens';
import * as twoFactor from './twoFactor';

async function meResponse(user: UserDoc): Promise<MeResponse> {
  const org = await Organization.findOne({ _id: user.orgId });
  if (!org) throw unauthorized();
  return { user: toUserDto(user), organization: toOrgDto(org) };
}

export function authRouter({ mailer }: { mailer: Mailer }): Router {
  const service = createAuthService({ mailer });
  const r = Router();

  r.post('/signup', authLimiter, async (req, res) => {
    const input = validate(signupSchema, req.body);
    const user = await service.signup(input, req);
    await issueSession(user, req, res);
    const body: LoginResponse = { status: 'ok', ...(await meResponse(user)) };
    res.status(201).json(body);
  });

  r.post('/login', authLimiter, async (req, res) => {
    const { email, password } = validate(loginSchema, req.body);
    const user = await service.checkPassword(email, password);
    if (user.twoFactor.enabled) {
      const body: LoginResponse = {
        status: 'two_factor_required',
        challengeToken: signChallengeToken(user),
      };
      res.json(body);
      return;
    }
    await service.recordLogin(user, req);
    await issueSession(user, req, res);
    const body: LoginResponse = { status: 'ok', ...(await meResponse(user)) };
    res.json(body);
  });

  r.post('/login/2fa', authLimiter, async (req, res) => {
    const { challengeToken, code } = validate(loginTwoFactorSchema, req.body);
    const userId = verifyChallengeToken(challengeToken);
    if (!userId)
      throw unauthorized('Your sign-in attempt expired, please start again', 'CHALLENGE_EXPIRED');
    const user = await service.checkTwoFactor(userId, code);
    await service.recordLogin(user, req);
    await issueSession(user, req, res);
    const body: LoginResponse = { status: 'ok', ...(await meResponse(user)) };
    res.json(body);
  });

  r.post('/refresh', async (req, res) => {
    const token: unknown = req.cookies?.[REFRESH_COOKIE];
    if (typeof token !== 'string' || !token) throw unauthorized();
    const result = await rotateSession(token, req, res);
    if (!result.ok) {
      clearAuthCookies(res);
      throw unauthorized('Session expired, please sign in again', 'SESSION_EXPIRED');
    }
    const user = await User.findOne({ _id: result.userId, orgId: result.orgId, active: true });
    if (!user) {
      clearAuthCookies(res);
      throw unauthorized();
    }
    await result.issue(user);
    res.json(await meResponse(user));
  });

  r.post('/logout', async (req, res) => {
    const token: unknown = req.cookies?.[REFRESH_COOKIE];
    if (typeof token === 'string' && token) await revokeSessionByToken(token);
    clearAuthCookies(res);
    res.status(204).end();
  });

  r.get('/me', requireAuth, async (req, res) => {
    const { user, org } = authed(req);
    const body: MeResponse = { user: toUserDto(user), organization: toOrgDto(org) };
    res.json(body);
  });

  r.post('/verify-email', authLimiter, async (req, res) => {
    const { token } = validate(tokenSchema, req.body);
    const user = await service.verifyEmail(token);
    res.json({ ok: true, email: user.email });
  });

  r.post('/verify-email/resend', authLimiter, requireAuth, async (req, res) => {
    const { user } = authed(req);
    if (user.emailVerifiedAt)
      throw badRequest('Your email is already verified', 'ALREADY_VERIFIED');
    await service.sendVerification(user, getAppBaseUrl(req));
    res.json({ ok: true });
  });

  r.post('/forgot-password', authLimiter, async (req, res) => {
    const { email } = validate(forgotPasswordSchema, req.body);
    await service.forgotPassword(email, getAppBaseUrl(req));
    res.json({ ok: true });
  });

  r.post('/reset-password', authLimiter, async (req, res) => {
    const { token, password } = validate(resetPasswordSchema, req.body);
    await service.resetPassword(token, password, req);
    clearAuthCookies(res);
    res.json({ ok: true });
  });

  r.get('/invites/:token', authLimiter, async (req, res) => {
    const found = await service.findPendingInvite(param(req, 'token'));
    if (!found) throw notFound('This invitation is invalid or has expired');
    res.json({
      email: found.invite.email,
      role: found.invite.role,
      organizationName: found.org.name,
    });
  });

  r.post('/accept-invite', authLimiter, async (req, res) => {
    const { token, name, password } = validate(acceptInviteSchema, req.body);
    const user = await service.acceptInvite(token, name, password, req);
    await issueSession(user, req, res);
    const body: LoginResponse = { status: 'ok', ...(await meResponse(user)) };
    res.status(201).json(body);
  });

  // --- Two-factor (TOTP) management for the signed-in user ---

  r.post('/2fa/setup', requireAuth, async (req, res) => {
    const { user } = authed(req);
    if (user.twoFactor.enabled) throw badRequest('Two-factor authentication is already on');
    res.json(await twoFactor.beginSetup(user));
  });

  r.post('/2fa/enable', requireAuth, async (req, res) => {
    const { user, orgId } = authed(req);
    const { code } = validate(enableTwoFactorSchema, req.body);
    const recoveryCodes = await twoFactor.confirmSetup(user, code);
    await audit({
      orgId,
      action: 'user.2fa_enabled',
      entity: { type: 'user', id: user._id.toString() },
      req,
    });
    res.json({ recoveryCodes });
  });

  r.post('/2fa/disable', requireAuth, async (req, res) => {
    const { user, orgId } = authed(req);
    const { password } = validate(disableTwoFactorSchema, req.body);
    if (!(await argon2.verify(user.passwordHash, password))) {
      throw unauthorized('Incorrect password', 'INVALID_CREDENTIALS');
    }
    await twoFactor.disable(user);
    await audit({
      orgId,
      action: 'user.2fa_disabled',
      entity: { type: 'user', id: user._id.toString() },
      req,
    });
    res.json({ ok: true });
  });

  return r;
}
