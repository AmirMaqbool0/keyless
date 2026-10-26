import { authenticator } from 'otplib';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CSRF_COOKIE, CSRF_HEADER } from '@keyless/shared';
import { Session } from '@keyless/core/models/Session';
import { REFRESH_COOKIE } from '../src/modules/auth/tokens';
import { User } from '@keyless/core/models/User';
import { PASSWORD, useTestApp } from './helpers';

const t = useTestApp();

const signupBody = {
  name: 'Sam Owner',
  email: 'sam@acme-supplies.co.uk',
  password: PASSWORD,
  organizationName: 'Acme Supplies Ltd',
};

describe('sign-up and email verification', () => {
  it('creates an org with the user as owner and requires verification', async () => {
    const c = await t.client();
    const res = await c.post('/api/auth/signup', signupBody);
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email: signupBody.email,
      role: 'owner',
      emailVerified: false,
    });
    expect(res.body.organization).toMatchObject({
      name: 'Acme Supplies Ltd',
      slug: 'acme-supplies-ltd',
      currency: 'GBP',
    });

    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(200);

    const blocked = await c.get('/api/users');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const verify = await c.post('/api/auth/verify-email', {
      token: t.tokenFromLastEmail(signupBody.email),
    });
    expect(verify.status).toBe(200);
    expect((await c.get('/api/users')).status).toBe(200);
  });

  it('rejects a used or bogus verification token', async () => {
    const c = await t.client();
    await c.post('/api/auth/signup', signupBody);
    const token = t.tokenFromLastEmail(signupBody.email);
    expect((await c.post('/api/auth/verify-email', { token })).status).toBe(200);
    expect((await c.post('/api/auth/verify-email', { token })).status).toBe(400);
    expect((await c.post('/api/auth/verify-email', { token: 'nope' })).status).toBe(400);
  });

  it('rejects duplicate emails and weak passwords', async () => {
    const c = await t.client();
    await c.post('/api/auth/signup', signupBody);
    const dup = await (await t.client()).post('/api/auth/signup', signupBody);
    expect(dup.status).toBe(409);
    const weak = await (
      await t.client()
    ).post('/api/auth/signup', { ...signupBody, email: 'x@y.com', password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('login, sessions and CSRF', () => {
  it('logs in, rejects wrong passwords with a generic error', async () => {
    const user = await t.createUser({ role: 'reviewer' });
    const c = await t.client();
    const bad = await c.post('/api/auth/login', { email: user.email, password: 'wrong-password!' });
    expect(bad.status).toBe(401);
    const unknown = await c.post('/api/auth/login', {
      email: 'nobody@example.com',
      password: PASSWORD,
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe(bad.body.error.message);

    const ok = await c.post('/api/auth/login', {
      email: user.email.toUpperCase(),
      password: PASSWORD,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('ok');
    expect((await c.get('/api/auth/me')).body.user.id).toBe(user._id.toString());
  });

  it('blocks state-changing requests without the CSRF header', async () => {
    const user = await t.createUser({ role: 'owner' });
    const c = await t.loginAs(user.email);
    const res = await c.agent.patch('/api/org').send({ name: 'Hacked' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const user = await t.createUser({ role: 'viewer' });
    const c = await t.client();
    const login = await c.post('/api/auth/login', { email: user.email, password: PASSWORD });
    const cookies = ([] as string[]).concat(login.headers['set-cookie'] ?? []);
    const oldRefresh = cookies.find((h) => h.startsWith(`${REFRESH_COOKIE}=`))!.split(';')[0]!;

    expect((await c.post('/api/auth/refresh')).status).toBe(200);
    expect(await Session.countDocuments({ orgId: user.orgId, revokedAt: null })).toBe(1);

    // An attacker replays the first (rotated) token after the two-tab grace window.
    await Session.updateMany(
      { orgId: user.orgId, rotatedAt: { $ne: null } },
      { rotatedAt: new Date(Date.now() - 60_000) },
    );
    const csrf = 'x'.repeat(32);
    const replay = await request(t.app)
      .post('/api/auth/refresh')
      .set('Cookie', [oldRefresh, `${CSRF_COOKIE}=${csrf}`])
      .set(CSRF_HEADER, csrf);
    expect(replay.status).toBe(401);

    // The whole family is revoked, so the legitimate client is signed out too.
    expect(await Session.countDocuments({ orgId: user.orgId, revokedAt: null })).toBe(0);
    expect((await c.post('/api/auth/refresh')).status).toBe(401);
  });

  it('logout ends the session', async () => {
    const user = await t.createUser({ role: 'viewer' });
    const c = await t.loginAs(user.email);
    expect((await c.post('/api/auth/logout')).status).toBe(204);
    expect((await c.get('/api/auth/me')).status).toBe(401);
    expect((await c.post('/api/auth/refresh')).status).toBe(401);
  });
});

describe('password reset', () => {
  it('resets the password and kills existing sessions', async () => {
    const user = await t.createUser({ role: 'admin' });
    const existing = await t.loginAs(user.email);

    const c = await t.client();
    expect((await c.post('/api/auth/forgot-password', { email: user.email })).status).toBe(200);
    // Unknown emails get the same response and no email.
    expect((await c.post('/api/auth/forgot-password', { email: 'ghost@example.com' })).status).toBe(
      200,
    );
    expect(t.mailer.outbox).toHaveLength(1);

    const token = t.tokenFromLastEmail(user.email);
    const newPassword = 'a-brand-new-password';
    expect(
      (await c.post('/api/auth/reset-password', { token, password: newPassword })).status,
    ).toBe(200);

    expect((await existing.get('/api/auth/me')).status).toBe(401);
    expect((await existing.post('/api/auth/refresh')).status).toBe(401);
    expect(
      (await c.post('/api/auth/login', { email: user.email, password: PASSWORD })).status,
    ).toBe(401);
    expect(
      (await c.post('/api/auth/login', { email: user.email, password: newPassword })).status,
    ).toBe(200);
    expect(
      (await c.post('/api/auth/reset-password', { token, password: newPassword })).status,
    ).toBe(400);
  });
});

describe('two-factor authentication', () => {
  it('enables TOTP, then requires a code (or a single-use recovery code) at login', async () => {
    const user = await t.createUser({ role: 'owner' });
    const c = await t.loginAs(user.email);

    const setup = await c.post('/api/auth/2fa/setup');
    expect(setup.status).toBe(200);
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const secret: string = setup.body.secret;

    expect((await c.post('/api/auth/2fa/enable', { code: '000000' })).status).toBe(400);
    const enabled = await c.post('/api/auth/2fa/enable', { code: authenticator.generate(secret) });
    expect(enabled.status).toBe(200);
    const recoveryCodes: string[] = enabled.body.recoveryCodes;
    expect(recoveryCodes).toHaveLength(8);

    const stored = await User.findOne({ _id: user._id, orgId: user.orgId });
    expect(stored!.twoFactor.secretEnc).toBeDefined();
    expect(stored!.twoFactor.secretEnc).not.toContain(secret);

    const fresh = await t.client();
    const step1 = await fresh.post('/api/auth/login', { email: user.email, password: PASSWORD });
    expect(step1.body.status).toBe('two_factor_required');
    expect((await fresh.get('/api/auth/me')).status).toBe(401);

    const wrong = await fresh.post('/api/auth/login/2fa', {
      challengeToken: step1.body.challengeToken,
      code: '123456',
    });
    expect(wrong.status).toBe(401);
    const right = await fresh.post('/api/auth/login/2fa', {
      challengeToken: step1.body.challengeToken,
      code: authenticator.generate(secret),
    });
    expect(right.status).toBe(200);

    const other = await t.client();
    const s = await other.post('/api/auth/login', { email: user.email, password: PASSWORD });
    const recovery = recoveryCodes[0]!;
    expect(
      (
        await other.post('/api/auth/login/2fa', {
          challengeToken: s.body.challengeToken,
          code: recovery,
        })
      ).status,
    ).toBe(200);
    const again = await (
      await t.client()
    ).post('/api/auth/login', { email: user.email, password: PASSWORD });
    const reuse = await (
      await t.client()
    ).post('/api/auth/login/2fa', { challengeToken: again.body.challengeToken, code: recovery });
    expect(reuse.status).toBe(401);
  });
});
