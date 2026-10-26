import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/AuditLog';
import { PASSWORD, useTestApp } from './helpers';

const t = useTestApp();

describe('invitations', () => {
  it('owner invites a reviewer who accepts and signs in', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const oc = await t.loginAs(owner.email);

    const inv = await oc.post('/api/users/invites', {
      email: 'New.Person@Example.com',
      role: 'reviewer',
    });
    expect(inv.status).toBe(201);
    expect(inv.body.invite).toMatchObject({ email: 'new.person@example.com', role: 'reviewer' });
    expect((await oc.get('/api/users/invites')).body.invites).toHaveLength(1);

    const token = t.tokenFromLastEmail('new.person@example.com');
    const guest = await t.client();
    const info = await guest.get(`/api/auth/invites/${token}`);
    expect(info.body).toMatchObject({
      email: 'new.person@example.com',
      role: 'reviewer',
      organizationName: 'Org',
    });

    const accepted = await guest.post('/api/auth/accept-invite', {
      token,
      name: 'New Person',
      password: PASSWORD,
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body.user).toMatchObject({
      role: 'reviewer',
      emailVerified: true,
      orgId: owner.orgId.toString(),
    });

    // Token is single-use; invite no longer pending.
    expect(
      (await guest.post('/api/auth/accept-invite', { token, name: 'Again', password: PASSWORD }))
        .status,
    ).toBe(400);
    expect((await oc.get('/api/users/invites')).body.invites).toHaveLength(0);
    expect((await oc.get('/api/users')).body.users).toHaveLength(2);

    const actions = (await AuditLog.find({ orgId: owner.orgId })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['invite.created', 'invite.accepted']));
  });

  it('re-inviting replaces the pending invite; revoked invites cannot be used', async () => {
    const admin = await t.createUser({ role: 'admin' });
    const c = await t.loginAs(admin.email);
    await c.post('/api/users/invites', { email: 'a@example.com', role: 'viewer' });
    const first = t.tokenFromLastEmail('a@example.com');
    const second = await c.post('/api/users/invites', { email: 'a@example.com', role: 'reviewer' });
    expect((await c.get('/api/users/invites')).body.invites).toHaveLength(1);
    expect((await (await t.client()).get(`/api/auth/invites/${first}`)).status).toBe(404);

    expect((await c.delete(`/api/users/invites/${second.body.invite.id}`)).status).toBe(204);
    const token = t.tokenFromLastEmail('a@example.com');
    expect((await (await t.client()).get(`/api/auth/invites/${token}`)).status).toBe(404);
  });

  it('rejects inviting existing members', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const c = await t.loginAs(owner.email);
    const res = await c.post('/api/users/invites', { email: owner.email, role: 'viewer' });
    expect(res.status).toBe(409);
  });
});

describe('role enforcement', () => {
  it('reviewers and viewers cannot manage users or settings', async () => {
    const owner = await t.createUser({ role: 'owner' });
    for (const role of ['reviewer', 'viewer'] as const) {
      const u = await t.createUser({ role, orgId: owner.orgId });
      const c = await t.loginAs(u.email);
      expect((await c.get('/api/users')).status).toBe(200); // can see the team
      expect((await c.get('/api/users/invites')).status).toBe(403);
      expect(
        (await c.post('/api/users/invites', { email: 'z@example.com', role: 'viewer' })).status,
      ).toBe(403);
      expect((await c.patch(`/api/users/${owner._id}/role`, { role: 'viewer' })).status).toBe(403);
      expect((await c.patch('/api/org', { name: 'Renamed' })).status).toBe(403);
      expect((await c.get('/api/audit')).status).toBe(403);
    }
  });

  it('admins cannot create or modify owners', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const admin = await t.createUser({ role: 'admin', orgId: owner.orgId });
    const reviewer = await t.createUser({ role: 'reviewer', orgId: owner.orgId });
    const c = await t.loginAs(admin.email);

    expect(
      (await c.post('/api/users/invites', { email: 'boss@example.com', role: 'owner' })).status,
    ).toBe(403);
    expect((await c.patch(`/api/users/${owner._id}/role`, { role: 'viewer' })).status).toBe(403);
    expect((await c.delete(`/api/users/${owner._id}`)).status).toBe(403);
    expect((await c.patch(`/api/users/${reviewer._id}/role`, { role: 'owner' })).status).toBe(403);

    const promoted = await c.patch(`/api/users/${reviewer._id}/role`, { role: 'admin' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.user.role).toBe('admin');
    expect((await c.patch('/api/org', { name: 'Renamed Ltd' })).body.organization.name).toBe(
      'Renamed Ltd',
    );
  });

  it('role changes apply immediately to an existing session', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const admin = await t.createUser({ role: 'admin', orgId: owner.orgId });
    const adminClient = await t.loginAs(admin.email);
    expect((await adminClient.get('/api/users/invites')).status).toBe(200);

    const oc = await t.loginAs(owner.email);
    await oc.patch(`/api/users/${admin._id}/role`, { role: 'viewer' });
    expect((await adminClient.get('/api/users/invites')).status).toBe(403);
  });

  it('keeps at least one owner and blocks self-management', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const c = await t.loginAs(owner.email);
    expect((await c.patch(`/api/users/${owner._id}/role`, { role: 'admin' })).status).toBe(403);
    expect((await c.delete(`/api/users/${owner._id}`)).status).toBe(403);

    const second = await t.createUser({ role: 'owner', orgId: owner.orgId });
    expect((await c.patch(`/api/users/${second._id}/role`, { role: 'admin' })).status).toBe(200);
  });

  it('removing a user ends their sessions', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const reviewer = await t.createUser({ role: 'reviewer', orgId: owner.orgId });
    const rc = await t.loginAs(reviewer.email);
    const oc = await t.loginAs(owner.email);

    expect((await oc.delete(`/api/users/${reviewer._id}`)).status).toBe(204);
    expect((await rc.get('/api/auth/me')).status).toBe(401);
    expect((await rc.post('/api/auth/refresh')).status).toBe(401);
    expect((await oc.get('/api/users')).body.users).toHaveLength(1);
  });
});
