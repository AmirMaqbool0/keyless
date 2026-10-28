import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { Attachment } from '@keyless/core/models/Attachment';
import { AuditLog } from '@keyless/core/models/AuditLog';
import { InboundEmail } from '@keyless/core/models/InboundEmail';
import { Job } from '@keyless/core/models/Job';
import { Order } from '@keyless/core/models/Order';
import { Organization } from '@keyless/core/models/Organization';
import { Session } from '@keyless/core/models/Session';
import { useTestApp } from './helpers';

describe('Milestone 10: Hardening, Super-admin & GDPR Compliance', () => {
  const { createUser, loginAs, storage } = useTestApp();

  describe('Super-admin Platform Controls', () => {
    it('forbids regular users (even owners) from accessing superadmin endpoints', async () => {
      const owner = await createUser({ role: 'owner' });
      const client = await loginAs(owner.email);

      const res = await client.get('/api/superadmin/metrics');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('NOT_SUPERADMIN');
    });

    it('allows super-admins to inspect platform metrics and tenant directory', async () => {
      const superadmin = await createUser({ role: 'owner' });
      superadmin.isSuperAdmin = true;
      await superadmin.save();

      // Create another tenant with orders
      const otherOrg = await Organization.create({
        name: 'Acme Wholesale',
        slug: 'acme-wholesale',
        plan: 'growth',
        subscriptionStatus: 'active',
      });
      await createUser({ role: 'reviewer', orgId: otherOrg._id });

      const client = await loginAs(superadmin.email);

      // Check metrics
      const metricsRes = await client.get('/api/superadmin/metrics');
      expect(metricsRes.status).toBe(200);
      expect(metricsRes.body.metrics.totalTenants).toBeGreaterThanOrEqual(2);
      expect(metricsRes.body.metrics.activeSubscriptions).toBeGreaterThanOrEqual(1);

      // Check tenants list
      const tenantsRes = await client.get('/api/superadmin/tenants');
      expect(tenantsRes.status).toBe(200);
      const acme = tenantsRes.body.tenants.find(
        (t: { slug: string; name: string; plan: string }) => t.slug === 'acme-wholesale',
      );
      expect(acme).toBeDefined();
      expect(acme.name).toBe('Acme Wholesale');
      expect(acme.plan).toBe('growth');

      // Check single tenant details
      const detailRes = await client.get(`/api/superadmin/tenants/${otherOrg._id}`);
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.organization.name).toBe('Acme Wholesale');
      expect(detailRes.body.users.length).toBe(1);
    });

    it('allows super-admins to view, retry, and dismiss failed queue jobs', async () => {
      const superadmin = await createUser({ role: 'admin' });
      superadmin.isSuperAdmin = true;
      await superadmin.save();

      // Create failed jobs in Mongo queue
      const job1 = await Job.create({
        name: 'sync-mailbox',
        data: { mailboxId: new mongoose.Types.ObjectId() },
        status: 'failed',
        attempts: 5,
        maxAttempts: 5,
        lastError: 'ETIMEDOUT: Connection to Microsoft Graph failed',
      });

      const job2 = await Job.create({
        name: 'parse-email',
        data: { emailId: new mongoose.Types.ObjectId() },
        status: 'failed',
        attempts: 3,
        maxAttempts: 3,
        lastError: 'Corrupt MIME payload',
      });

      const client = await loginAs(superadmin.email);

      // List failed jobs
      const listRes = await client.get('/api/superadmin/failed-jobs');
      expect(listRes.status).toBe(200);
      expect(listRes.body.jobs.length).toBeGreaterThanOrEqual(2);

      // Retry job 1
      const retryRes = await client.post(`/api/superadmin/failed-jobs/${job1._id}/retry`);
      expect(retryRes.status).toBe(200);
      expect(retryRes.body.job.status).toBe('waiting');

      const updatedJob1 = await Job.findById(job1._id);
      expect(updatedJob1?.status).toBe('waiting');
      expect(updatedJob1?.attempts).toBe(0);

      // Dismiss job 2
      const dismissRes = await client.post(`/api/superadmin/failed-jobs/${job2._id}/dismiss`);
      expect(dismissRes.status).toBe(200);
      expect(dismissRes.body.dismissed).toBe(true);

      const updatedJob2 = await Job.findById(job2._id);
      expect(updatedJob2?.status).toBe('completed');
    });

    it('enables super-admin support impersonation with audit logging', async () => {
      const superadmin = await createUser({ role: 'admin' });
      superadmin.isSuperAdmin = true;
      await superadmin.save();

      const customerOrg = await Organization.create({
        name: 'Target Customer',
        slug: 'target-customer',
      });
      const targetUser = await createUser({
        role: 'reviewer',
        orgId: customerOrg._id,
        email: 'support-target@customer.local',
      });

      const client = await loginAs(superadmin.email);

      // Impersonate
      const impersonateRes = await client.post(`/api/superadmin/impersonate/${targetUser._id}`);
      expect(impersonateRes.status).toBe(200);
      expect(impersonateRes.body.ok).toBe(true);
      expect(impersonateRes.body.user.email).toBe(targetUser.email);

      // Client session should now reflect the target user
      const meRes = await client.get('/api/auth/me');
      expect(meRes.status).toBe(200);
      expect(meRes.body.user.id).toBe(targetUser._id.toString());
      expect(meRes.body.organization.id).toBe(customerOrg._id.toString());

      // Verify audit log entry was written
      const auditEntry = await AuditLog.findOne({
        orgId: customerOrg._id,
        action: 'auth.impersonated',
      });
      expect(auditEntry).toBeDefined();
      expect(auditEntry?.actor.type).toBe('superadmin');
      expect(auditEntry?.actor.email).toBe(superadmin.email);
    });
  });

  describe('GDPR Data Portability & Retention', () => {
    it('exports complete organization data bundle as JSON', async () => {
      const owner = await createUser({ role: 'owner' });
      const client = await loginAs(owner.email);

      const exportRes = await client.post('/api/org/export');
      expect(exportRes.status).toBe(200);
      expect(exportRes.body.organization).toBeDefined();
      expect(exportRes.body.counts).toBeDefined();
      expect(exportRes.body.data).toHaveProperty('customers');
      expect(exportRes.body.data).toHaveProperty('products');
      expect(exportRes.body.data).toHaveProperty('orders');
    });

    it('prunes expired raw emails and attachments while preserving order history', async () => {
      const org = await Organization.create({
        name: 'Retention Org',
        slug: `retention-${Date.now()}`,
        settings: { retentionDays: 30 },
      });
      const owner = await createUser({ role: 'owner', orgId: org._id });

      // Save raw files in storage
      const emailId = new mongoose.Types.ObjectId();
      const emailStorageKey = `raw-emails/${org._id}/test-email.eml`;
      const attStorageKey = `attachments/${org._id}/po.pdf`;
      await storage.put(emailStorageKey, Buffer.from('From: buyer@test.local\r\nSubject: PO 123\r\n\r\nOrder'));
      await storage.put(attStorageKey, Buffer.from('%PDF-1.4 test dummy'));

      const attachment = await Attachment.create({
        orgId: org._id,
        emailId,
        storageKey: attStorageKey,
        filename: 'po.pdf',
        mimeType: 'application/pdf',
        size: 100,
        kind: 'pdf',
        sha256: 'abcd1234dummy',
      });

      // Email received 45 days ago (> 30 days retention)
      const pastDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
      const email = await InboundEmail.create({
        _id: emailId,
        orgId: org._id,
        source: 'upload',
        providerMessageId: `msg-${Date.now()}`,
        rawSize: 120,
        from: { address: 'buyer@test.local' },
        to: ['orders@retention.local'],
        subject: 'PO 123',
        text: 'Secret raw customer order message text',
        rawStorageKey: emailStorageKey,
        attachmentIds: [attachment._id],
        receivedAt: pastDate,
      });

      // Create an order referencing this email
      await Order.create({
        orgId: org._id,
        emailId: email._id,
        poNumber: 'PO-12345',
        sourceLabel: 'PO-12345.pdf',
        sourceIndex: 0,
        customerMatch: { method: 'sender', confidence: 1, candidates: [] },
        documentTotals: { total: 500 },
        currency: 'GBP',
        status: 'approved',
        colour: 'green',
        confidence: 0.95,
        extractionConfidence: 0.95,
        lines: [],
        issues: [],
        relatedEmails: [],
        receivedAt: pastDate,
        version: 1,
      });

      const client = await loginAs(owner.email);

      // Trigger prune
      const pruneRes = await client.post('/api/org/retention/cleanup');
      expect(pruneRes.status).toBe(200);
      expect(pruneRes.body.emailsPruned).toBe(1);
      expect(pruneRes.body.attachmentsPruned).toBe(1);

      // Raw storage should be deleted
      await expect(storage.get(emailStorageKey)).rejects.toThrow();
      await expect(storage.get(attStorageKey)).rejects.toThrow();

      // Email record text wiped
      const updatedEmail = await InboundEmail.findOne({ _id: email._id, orgId: org._id });
      expect(updatedEmail?.rawStorageKey).toBe('[deleted]');
      expect(updatedEmail?.text).toContain('[Raw email body deleted per data retention policy]');

      // But structured Order remains intact for statutory records!
      const preservedOrder = await Order.findOne({ orgId: org._id, poNumber: 'PO-12345' });
      expect(preservedOrder).toBeDefined();
      expect(preservedOrder?.documentTotals.total).toBe(500);
      expect(preservedOrder?.status).toBe('approved');
    });

    it('enforces owner-only organization deletion with slug confirmation', async () => {
      const org = await Organization.create({
        name: 'Delete Me Org',
        slug: 'delete-me-org',
      });
      const admin = await createUser({ role: 'admin', orgId: org._id });
      const owner = await createUser({ role: 'owner', orgId: org._id });

      // Admin cannot delete org
      const adminClient = await loginAs(admin.email);
      const forbiddenRes = await adminClient.delete('/api/org', { confirmSlug: 'delete-me-org' });
      expect(forbiddenRes.status).toBe(403);

      // Owner with wrong slug
      const ownerClient = await loginAs(owner.email);
      const badSlugRes = await ownerClient.delete('/api/org', { confirmSlug: 'wrong-slug' });
      expect(badSlugRes.status).toBe(400);
      expect(badSlugRes.body.error.code).toBe('SLUG_MISMATCH');

      // Owner with correct slug
      const deleteRes = await ownerClient.delete('/api/org', { confirmSlug: 'delete-me-org' });
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.deleted).toBe(true);

      const deletedOrg = await Organization.findById(org._id);
      expect(deletedOrg?.deletedAt).toBeDefined();

      // Sessions should be revoked
      const activeSessions = await Session.countDocuments({ orgId: org._id, revokedAt: null });
      expect(activeSessions).toBe(0);
    });
  });
});
