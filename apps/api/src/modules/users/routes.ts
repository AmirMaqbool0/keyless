import { Router } from 'express';
import {
  assignableRoles,
  inviteUserSchema,
  updateUserRoleSchema,
  type Role,
} from '@keyless/shared';
import { env, getAppBaseUrl } from '@keyless/core/config/env';
import { audit } from '@keyless/core/lib/audit';
import { inviteMail } from '@keyless/core/lib/emailTemplates';
import { conflict, forbidden, notFound, param, validate } from '@keyless/core/lib/http';
import type { Mailer } from '@keyless/core/lib/mailer';
import { hashToken, randomToken } from '@keyless/core/lib/tokens';
import { authed, requireRole } from '../../middleware/auth';
import { Invite } from '@keyless/core/models/Invite';
import { User, type UserDoc } from '@keyless/core/models/User';
import { revokeAllSessions } from '../auth/tokens';
import { activeUserByEmail } from '../auth/service';
import { toInviteDto, toUserDto } from '../dto';
import { objectId } from '../shared';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Rules for an actor changing or removing another member. */
function assertCanManage(actor: UserDoc, target: UserDoc, newRole?: Role): void {
  if (actor._id.equals(target._id))
    throw forbidden('You cannot change your own membership', 'SELF_MANAGE');
  if (target.role === 'owner' && actor.role !== 'owner')
    throw forbidden('Only an owner can change another owner');
  if (newRole && !assignableRoles(actor.role).includes(newRole)) {
    throw forbidden(`You cannot assign the ${newRole} role`);
  }
}

async function assertNotLastOwner(target: UserDoc): Promise<void> {
  if (target.role !== 'owner') return;
  const owners = await User.countDocuments({ orgId: target.orgId, role: 'owner', active: true });
  if (owners <= 1) throw conflict('An organisation must keep at least one owner', 'LAST_OWNER');
}

/** Mounted behind requireAuth + requireVerified. */
export function usersRouter({ mailer }: { mailer: Mailer }): Router {
  const r = Router();

  // Any member can see who is on the team.
  r.get('/', async (req, res) => {
    const { orgId } = authed(req);
    const users = await User.find({ orgId, active: true }).sort({ createdAt: 1 });
    res.json({ users: users.map(toUserDto) });
  });

  r.get('/invites', requireRole('admin'), async (req, res) => {
    const { orgId } = authed(req);
    const invites = await Invite.find({
      orgId,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });
    res.json({ invites: invites.map(toInviteDto) });
  });

  r.post('/invites', requireRole('admin'), async (req, res) => {
    const { user: actor, org, orgId } = authed(req);
    const { email, role } = validate(inviteUserSchema, req.body);
    if (!assignableRoles(actor.role).includes(role))
      throw forbidden(`You cannot invite someone as ${role}`);

    const existing = await activeUserByEmail(email);
    if (existing) {
      throw conflict(
        existing.orgId.equals(orgId)
          ? 'This person is already a member'
          : 'This email already has a Keyless account',
        'EMAIL_TAKEN',
      );
    }
    // Re-inviting replaces any pending invite for the same email.
    await Invite.updateMany(
      { orgId, email, acceptedAt: null, revokedAt: null },
      { revokedAt: new Date() },
    );

    const token = randomToken();
    const invite = await Invite.create({
      orgId,
      email,
      role,
      tokenHash: hashToken(token),
      invitedBy: actor._id,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });
    const url = `${getAppBaseUrl(req)}/accept-invite?token=${encodeURIComponent(token)}`;
    await mailer.send(inviteMail(email, actor.name, org.name, role, url));
    await audit({
      orgId,
      action: 'invite.created',
      entity: { type: 'invite', id: invite._id.toString() },
      summary: { email, role },
      req,
    });
    res.status(201).json({ invite: toInviteDto(invite) });
  });

  r.delete('/invites/:id', requireRole('admin'), async (req, res) => {
    const { orgId } = authed(req);
    const invite = await Invite.findOneAndUpdate(
      { _id: objectId(param(req, 'id')), orgId, acceptedAt: null, revokedAt: null },
      { revokedAt: new Date() },
    );
    if (!invite) throw notFound('Invitation not found');
    await audit({
      orgId,
      action: 'invite.revoked',
      entity: { type: 'invite', id: invite._id.toString() },
      summary: { email: invite.email },
      req,
    });
    res.status(204).end();
  });

  r.patch('/:id/role', requireRole('admin'), async (req, res) => {
    const { user: actor, orgId } = authed(req);
    const { role } = validate(updateUserRoleSchema, req.body);
    const target = await User.findOne({ _id: objectId(param(req, 'id')), orgId, active: true });
    if (!target) throw notFound('User not found');
    assertCanManage(actor, target, role);
    if (target.role === role) {
      res.json({ user: toUserDto(target) });
      return;
    }
    if (role !== 'owner') await assertNotLastOwner(target);

    const before = target.role;
    target.role = role;
    await target.save();
    await audit({
      orgId,
      action: 'user.role_changed',
      entity: { type: 'user', id: target._id.toString() },
      summary: { before, after: role },
      req,
    });
    res.json({ user: toUserDto(target) });
  });

  r.delete('/:id', requireRole('admin'), async (req, res) => {
    const { user: actor, orgId } = authed(req);
    const target = await User.findOne({ _id: objectId(param(req, 'id')), orgId, active: true });
    if (!target) throw notFound('User not found');
    assertCanManage(actor, target);
    await assertNotLastOwner(target);

    target.active = false;
    target.tokenVersion += 1;
    await target.save();
    await revokeAllSessions(target);
    await audit({
      orgId,
      action: 'user.removed',
      entity: { type: 'user', id: target._id.toString() },
      summary: { email: target.email, role: target.role },
      req,
    });
    res.status(204).end();
  });

  return r;
}
