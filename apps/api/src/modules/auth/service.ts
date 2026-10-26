import crypto from 'node:crypto';
import argon2 from 'argon2';
import type { Request } from 'express';
import type { SignupInput } from '@keyless/shared';
import { env } from '../../config/env';
import { audit } from '../../lib/audit';
import { resetPasswordMail, verifyEmailMail } from '../../lib/emailTemplates';
import { badRequest, conflict, unauthorized } from '../../lib/http';
import type { Mailer } from '../../lib/mailer';
import { hashToken, randomToken } from '../../lib/tokens';
import { AuthToken } from '../../models/AuthToken';
import { Invite } from '../../models/Invite';
import { Organization } from '../../models/Organization';
import { User, type UserDoc } from '../../models/User';
import { revokeAllSessions } from './tokens';
import { verifyLoginCode } from './twoFactor';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });

// Verified against when the email is unknown, so response time does not reveal which emails exist.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex')));

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'org';
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  while (await Organization.exists({ slug: candidate })) {
    candidate = `${base}-${crypto.randomBytes(3).toString('hex')}`;
  }
  return candidate;
}

export async function activeUserByEmail(email: string): Promise<UserDoc | null> {
  return User.findOne({ email, active: true }).setOptions({ skipTenant: true });
}

export function createAuthService({ mailer }: { mailer: Mailer }) {
  async function sendVerification(user: UserDoc): Promise<void> {
    const token = randomToken();
    await AuthToken.create({
      orgId: user.orgId,
      userId: user._id,
      type: 'verify_email',
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
    });
    const url = `${env.APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
    await mailer.send(verifyEmailMail(user.email, user.name, url));
  }

  /** Consume a one-time email token; returns the owning user or null. */
  async function consumeToken(
    type: 'verify_email' | 'reset_password',
    token: string,
  ): Promise<UserDoc | null> {
    const record = await AuthToken.findOneAndUpdate(
      { tokenHash: hashToken(token), type, usedAt: null, expiresAt: { $gt: new Date() } },
      { usedAt: new Date() },
    ).setOptions({ skipTenant: true });
    if (!record) return null;
    return User.findOne({ _id: record.userId, orgId: record.orgId, active: true });
  }

  return {
    sendVerification,

    async signup(input: SignupInput, req: Request): Promise<UserDoc> {
      if (await activeUserByEmail(input.email)) {
        throw conflict('An account with this email already exists', 'EMAIL_TAKEN');
      }
      const org = await Organization.create({
        name: input.organizationName,
        slug: await uniqueSlug(input.organizationName),
      });
      let user: UserDoc;
      try {
        user = await User.create({
          orgId: org._id,
          name: input.name,
          email: input.email,
          passwordHash: await hashPassword(input.password),
          role: 'owner',
        });
      } catch (err) {
        await Organization.deleteOne({ _id: org._id });
        throw err;
      }
      await audit({
        orgId: org._id,
        action: 'org.created',
        entity: { type: 'organization', id: org._id.toString() },
        actor: { userId: user._id, email: user.email, type: 'user' },
        req,
      });
      await sendVerification(user);
      return user;
    },

    async verifyEmail(token: string): Promise<UserDoc> {
      const user = await consumeToken('verify_email', token);
      if (!user)
        throw badRequest('This verification link is invalid or has expired', 'INVALID_TOKEN');
      if (!user.emailVerifiedAt) {
        user.emailVerifiedAt = new Date();
        await user.save();
      }
      return user;
    },

    /** Password step of login. Returns the user, who may still need a 2FA code. */
    async checkPassword(email: string, password: string): Promise<UserDoc> {
      const user = await activeUserByEmail(email);
      const ok = user
        ? await argon2.verify(user.passwordHash, password)
        : await argon2.verify(await getDummyHash(), password);
      if (!user || !ok) throw unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');
      return user;
    },

    async checkTwoFactor(userId: string, code: string): Promise<UserDoc> {
      const user = await User.findOne({ _id: userId, active: true }).setOptions({
        skipTenant: true,
      });
      if (!user || !(await verifyLoginCode(user, code))) {
        throw unauthorized('That code is not valid', 'INVALID_CODE');
      }
      return user;
    },

    async recordLogin(user: UserDoc, req: Request): Promise<void> {
      user.lastLoginAt = new Date();
      await user.save();
      await audit({
        orgId: user.orgId,
        action: 'user.login',
        entity: { type: 'user', id: user._id.toString() },
        req,
        actor: { userId: user._id, email: user.email, type: 'user' },
      });
    },

    async forgotPassword(email: string): Promise<void> {
      const user = await activeUserByEmail(email);
      if (!user) return; // Same response either way.
      const token = randomToken();
      await AuthToken.create({
        orgId: user.orgId,
        userId: user._id,
        type: 'reset_password',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      });
      await mailer.send(
        resetPasswordMail(
          user.email,
          `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`,
        ),
      );
    },

    async resetPassword(token: string, password: string, req: Request): Promise<void> {
      const user = await consumeToken('reset_password', token);
      if (!user) throw badRequest('This reset link is invalid or has expired', 'INVALID_TOKEN');
      user.passwordHash = await hashPassword(password);
      user.tokenVersion += 1;
      // Clicking the emailed link proves control of the address.
      user.emailVerifiedAt ??= new Date();
      await user.save();
      await revokeAllSessions(user);
      await audit({
        orgId: user.orgId,
        action: 'user.password_reset',
        entity: { type: 'user', id: user._id.toString() },
        req,
        actor: { userId: user._id, email: user.email, type: 'user' },
      });
    },

    async findPendingInvite(token: string) {
      const invite = await Invite.findOne({
        tokenHash: hashToken(token),
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      }).setOptions({ skipTenant: true });
      if (!invite) return null;
      const org = await Organization.findOne({ _id: invite.orgId, deletedAt: null });
      return org ? { invite, org } : null;
    },

    async acceptInvite(
      token: string,
      name: string,
      password: string,
      req: Request,
    ): Promise<UserDoc> {
      const found = await this.findPendingInvite(token);
      if (!found) throw badRequest('This invitation is invalid or has expired', 'INVALID_TOKEN');
      const { invite } = found;
      if (await activeUserByEmail(invite.email)) {
        throw conflict('An account with this email already exists', 'EMAIL_TAKEN');
      }
      const user = await User.create({
        orgId: invite.orgId,
        name,
        email: invite.email,
        passwordHash: await hashPassword(password),
        role: invite.role,
        emailVerifiedAt: new Date(),
      });
      invite.acceptedAt = new Date();
      await invite.save();
      await audit({
        orgId: invite.orgId,
        action: 'invite.accepted',
        entity: { type: 'user', id: user._id.toString() },
        summary: { role: invite.role, inviteId: invite._id.toString() },
        actor: { userId: user._id, email: user.email, type: 'user' },
        req,
      });
      return user;
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
