import { describe, expect, it } from 'vitest';
import { TenantScopeError } from '@keyless/core/db/tenant';
import { AuditLog } from '@keyless/core/models/AuditLog';
import { Invite } from '@keyless/core/models/Invite';
import { User } from '@keyless/core/models/User';
import { useTestApp } from './helpers';

const t = useTestApp();

describe('data-layer tenant scoping', () => {
  it('rejects queries on tenant collections without orgId', async () => {
    await expect(User.find({})).rejects.toBeInstanceOf(TenantScopeError);
    await expect(User.findOne({ email: 'a@b.com' })).rejects.toBeInstanceOf(TenantScopeError);
    await expect(User.updateMany({}, { name: 'x' })).rejects.toBeInstanceOf(TenantScopeError);
    await expect(Invite.deleteMany({})).rejects.toBeInstanceOf(TenantScopeError);
    await expect(User.countDocuments({ orgId: undefined })).rejects.toBeInstanceOf(
      TenantScopeError,
    );
    await expect(User.aggregate([{ $group: { _id: '$role' } }])).rejects.toBeInstanceOf(
      TenantScopeError,
    );
  });

  it('allows scoped queries and explicit, greppable cross-tenant lookups', async () => {
    const u = await t.createUser({ role: 'viewer' });
    expect(await User.findOne({ orgId: u.orgId, _id: u._id })).not.toBeNull();
    expect(await User.findOne({ email: u.email }).setOptions({ skipTenant: true })).not.toBeNull();
    expect(await User.aggregate([{ $match: { orgId: u.orgId } }, { $count: 'n' }])).toEqual([
      { n: 1 },
    ]);
  });

  it('keeps the audit log append-only', async () => {
    const u = await t.createUser({ role: 'viewer' });
    await AuditLog.create({
      orgId: u.orgId,
      actor: { type: 'system' },
      action: 'test',
      entity: { type: 'x' },
    });
    await expect(AuditLog.updateMany({ orgId: u.orgId }, { action: 'changed' })).rejects.toThrow(
      'append-only',
    );
    await expect(AuditLog.deleteMany({ orgId: u.orgId })).rejects.toThrow('append-only');
  });
});

describe('API tenant isolation', () => {
  it('an admin of org A cannot read or change anything in org B', async () => {
    const adminA = await t.createUser({ role: 'admin' });
    const ownerB = await t.createUser({ role: 'owner' });
    const reviewerB = await t.createUser({ role: 'reviewer', orgId: ownerB.orgId });

    const b = await t.loginAs(ownerB.email);
    const inviteB = (await b.post('/api/users/invites', { email: 'pending@b.com', role: 'viewer' }))
      .body.invite;

    const a = await t.loginAs(adminA.email);
    const users = (await a.get('/api/users')).body.users as { id: string }[];
    expect(users.map((u) => u.id)).toEqual([adminA._id.toString()]);
    expect((await a.get('/api/users/invites')).body.invites).toEqual([]);

    expect((await a.patch(`/api/users/${reviewerB._id}/role`, { role: 'viewer' })).status).toBe(
      404,
    );
    expect((await a.delete(`/api/users/${reviewerB._id}`)).status).toBe(404);
    expect((await a.delete(`/api/users/invites/${inviteB.id}`)).status).toBe(404);

    const orgA = (await a.get('/api/org')).body.organization;
    expect(orgA.id).toBe(adminA.orgId.toString());
    // orgId in the body is ignored: the org always comes from the session.
    await a.patch('/api/org', { name: 'A renamed', orgId: ownerB.orgId.toString() } as object);
    expect((await b.get('/api/org')).body.organization.name).toBe('Org');

    const auditA = (await a.get('/api/audit')).body.entries as { action: string }[];
    expect(auditA.some((e) => e.action === 'invite.created')).toBe(false);

    const stillThere = await User.findOne({ _id: reviewerB._id, orgId: ownerB.orgId });
    expect(stillThere?.role).toBe('reviewer');
    expect(stillThere?.active).toBe(true);
  });
});
