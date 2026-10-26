import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { sampleEmail, type SampleContext } from '@keyless/core/demo/sampleEmails';
import { Attachment } from '@keyless/core/models/Attachment';
import { InboundEmail } from '@keyless/core/models/InboundEmail';
import { Mailbox } from '@keyless/core/models/Mailbox';
import { useTestApp } from './helpers';

const t = useTestApp();
const SECRET = 'test-inbound-secret';

async function forwardingAddress(c: Awaited<ReturnType<typeof t.loginAs>>): Promise<string> {
  const res = await c.get('/api/mailboxes');
  return res.body.items.find((m: { type: string }) => m.type === 'forwarding').address;
}

const ctx = (to: string): SampleContext => ({
  customerName: 'Brew Cafe',
  senderName: 'Sam Buyer',
  senderAddress: 'orders@brewcafe.example',
  to,
  poNumber: 'PO-4471',
  deliveryAddress: ['1 High Street', 'Leeds', 'LS1 4AB'],
  lines: [
    { code: 'GL1001', description: 'Nitrile Gloves Blue Medium', quantity: 10, unitPrice: 4.5 },
    { code: 'BL2002', description: 'Refuse Sacks Black', quantity: 4, unitPrice: 9.95 },
  ],
});

const postRaw = (raw: Buffer, secret = SECRET) =>
  request(t.app)
    .post('/webhooks/inbound')
    .set('Content-Type', 'message/rfc822')
    .set('X-Inbound-Secret', secret)
    .send(raw);

describe('forwarding address -> classified email (the M3 "done when")', () => {
  it('stores, parses and classifies an emailed PDF purchase order', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const c = await t.loginAs(owner.email);
    const address = await forwardingAddress(c);
    expect(address).toMatch(/^orders-org-[a-z0-9-]+-[0-9a-f]{6}@in\.keyless\.test$/);

    const res = await postRaw(await sampleEmail('pdf_po', ctx(address)));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: true, duplicate: false });

    // Before the worker runs, the email is listed as received.
    expect((await c.get('/api/emails')).body.items[0]).toMatchObject({ status: 'received' });
    expect(await t.drainJobs()).toBe(3); // process-email, classify-email, extract-email

    const list = await c.get('/api/emails?view=orders');
    expect(list.body.total).toBe(1);
    const item = list.body.items[0];
    expect(item).toMatchObject({
      status: 'classified',
      source: 'forwarding',
      subject: 'Purchase Order PO-4471',
      from: { name: 'Sam Buyer', address: 'orders@brewcafe.example' },
      attachmentCount: 1,
      classification: { label: 'new_order', method: 'heuristic' },
    });

    const detail = await c.get(`/api/emails/${item.id}`);
    expect(detail.body.attachments).toEqual([
      expect.objectContaining({
        filename: 'PO-PO-4471.pdf',
        kind: 'pdf',
        mimeType: 'application/pdf',
        isInline: false,
      }),
    ]);
    expect(detail.body.timeline.map((e: { event: string }) => e.event)).toEqual([
      'Received',
      'Read',
      'Classified',
      'Extracted',
    ]);
    expect(detail.body.mailbox).toMatchObject({ type: 'forwarding', address });

    // The signed link serves the PDF without a session, and tampering breaks it.
    const pdf = await request(t.app).get(detail.body.attachments[0].url);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await request(t.app).get(`${detail.body.attachments[0].url}x`)).status).toBe(404);
    const raw = await request(t.app).get(detail.body.rawUrl);
    expect(raw.headers['content-disposition']).toContain('attachment');
    expect(raw.headers['content-security-policy']).toContain('sandbox');
  });

  it.each([
    ['csv_po', 'new_order'],
    ['body_order', 'new_order'],
    ['amendment', 'amendment'],
    ['cancellation', 'cancellation'],
    ['quote_request', 'quote_request'],
    ['delivery_query', 'delivery_query'],
    ['out_of_office', 'not_order'],
  ] as const)('classifies a %s email as %s', async (scenario, label) => {
    const owner = await t.createUser({ role: 'owner' });
    const c = await t.loginAs(owner.email);
    await postRaw(await sampleEmail(scenario, ctx(await forwardingAddress(c))));
    await t.drainJobs();
    const [email] = (await c.get('/api/emails')).body.items;
    expect(email.classification.label).toBe(label);
  });

  it('deduplicates repeat deliveries of the same message', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const c = await t.loginAs(owner.email);
    const raw = await sampleEmail('pdf_po', ctx(await forwardingAddress(c)));
    const first = await postRaw(raw);
    const second = await postRaw(raw);
    expect(second.body).toMatchObject({ duplicate: true, emailId: first.body.emailId });
    await t.drainJobs();
    expect((await c.get('/api/emails')).body.total).toBe(1);
  });

  it('routes by recipient to the right org and drops unknown addresses', async () => {
    const a = await t.createUser({ role: 'owner' });
    const b = await t.createUser({ role: 'owner' });
    const ca = await t.loginAs(a.email);
    const cb = await t.loginAs(b.email);
    await postRaw(await sampleEmail('body_order', ctx(await forwardingAddress(cb))));
    await t.drainJobs();
    expect((await ca.get('/api/emails')).body.total).toBe(0);
    expect((await cb.get('/api/emails')).body.total).toBe(1);

    const stray = await postRaw(
      await sampleEmail('body_order', ctx('orders-nobody-000000@in.keyless.test')),
    );
    expect(stray.status).toBe(202);
    expect(stray.body).toEqual({ accepted: false, reason: 'unknown_recipient' });

    // Envelope recipient wins even if the To header shows the customer's own address.
    const viaEnvelope = await request(t.app)
      .post('/webhooks/inbound')
      .set('Content-Type', 'message/rfc822')
      .set('X-Inbound-Secret', SECRET)
      .set('X-Envelope-To', await forwardingAddress(ca))
      .send(await sampleEmail('csv_po', ctx('orders@distributor.example')));
    expect(viaEnvelope.body.accepted).toBe(true);
  });

  it('accepts JSON (Postmark-style) and multipart (SendGrid-style) payloads, and Basic auth', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const c = await t.loginAs(owner.email);
    const address = await forwardingAddress(c);

    const json = await request(t.app)
      .post('/webhooks/inbound')
      .set('X-Inbound-Secret', SECRET)
      .send({
        RawEmail: (await sampleEmail('quote_request', ctx(address))).toString('utf8'),
        OriginalRecipient: address,
      });
    expect(json.body.accepted).toBe(true);

    const multipart = await request(t.app)
      .post('/webhooks/inbound')
      .auth('inbound', SECRET)
      .field('envelope', JSON.stringify({ to: [address], from: 'x@y.com' }))
      .field(
        'email',
        (await sampleEmail('body_order', ctx('someone@else.example'))).toString('utf8'),
      );
    expect(multipart.body.accepted).toBe(true);

    await t.drainJobs();
    expect((await c.get('/api/emails')).body.total).toBe(2);
  });

  it('rejects a wrong or missing webhook secret', async () => {
    const raw = await sampleEmail('pdf_po', ctx('a@in.keyless.test'));
    expect((await postRaw(raw, 'wrong')).status).toBe(401);
    expect(
      (
        await request(t.app)
          .post('/webhooks/inbound')
          .set('Content-Type', 'message/rfc822')
          .send(raw)
      ).status,
    ).toBe(401);
  });

  it('does not import while the forwarding address is paused', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const c = await t.loginAs(owner.email);
    const address = await forwardingAddress(c);
    await Mailbox.updateOne({ orgId: owner.orgId, type: 'forwarding' }, { status: 'paused' });
    const res = await postRaw(await sampleEmail('pdf_po', ctx(address)));
    expect(res.body).toEqual({ accepted: false, reason: 'mailbox_paused' });
  });
});

describe('manual upload, reclassify, reprocess', () => {
  it('reviewers upload .eml and order documents; the same file twice is one email', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const reviewer = await t.createUser({ role: 'reviewer', orgId: owner.orgId });
    const viewer = await t.createUser({ role: 'viewer', orgId: owner.orgId });
    const rc = await t.loginAs(reviewer.email);

    const eml = await sampleEmail('body_order', ctx('orders@distributor.example'));
    const pdfBytes = Buffer.from('%PDF-1.4 fake scanned order');

    const res = await rc.upload(
      '/api/emails/upload',
      {},
      { name: 'order.eml', content: eml },
      'files',
    );
    expect(res.status).toBe(201);
    const doc = await rc.upload(
      '/api/emails/upload',
      {},
      { name: 'scan.pdf', content: pdfBytes },
      'files',
    );
    const again = await rc.upload(
      '/api/emails/upload',
      {},
      { name: 'scan-copy.pdf', content: pdfBytes },
      'files',
    );
    expect(again.body.results[0]).toMatchObject({
      duplicate: true,
      emailId: doc.body.results[0].emailId,
    });
    const msg = await rc.upload(
      '/api/emails/upload',
      {},
      { name: 'notes.msg', content: 'x' },
      'files',
    );
    expect(msg.body.results[0].error).toContain('.msg');

    await t.drainJobs();
    const emails = (await rc.get('/api/emails')).body.items as {
      subject: string;
      source: string;
      classification: { label: string; reasons: string[] };
    }[];
    expect(emails).toHaveLength(2);
    const uploaded = emails.find((e) => e.subject === 'Uploaded: scan.pdf')!;
    expect(uploaded).toMatchObject({ source: 'upload', classification: { label: 'new_order' } });
    expect(uploaded.classification.reasons[0]).toContain('Uploaded');

    const vc = await t.loginAs(viewer.email);
    expect(
      (await vc.upload('/api/emails/upload', {}, { name: 'scan.pdf', content: pdfBytes }, 'files'))
        .status,
    ).toBe(403);
    expect((await vc.get('/api/emails')).status).toBe(200);
  });

  it('a reviewer can correct the classification and automatic runs never overwrite it', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const c = await t.loginAs(owner.email);
    await postRaw(await sampleEmail('quote_request', ctx(await forwardingAddress(c))));
    await t.drainJobs();
    const [email] = (await c.get('/api/emails')).body.items;

    const fixed = await c.post(`/api/emails/${email.id}/reclassify`, { label: 'new_order' });
    expect(fixed.body.classification).toMatchObject({
      label: 'new_order',
      method: 'manual',
      confidence: 1,
    });

    expect((await c.post(`/api/emails/${email.id}/reprocess`)).status).toBe(200);
    await t.drainJobs();
    const detail = await c.get(`/api/emails/${email.id}`);
    expect(detail.body.classification).toMatchObject({ label: 'new_order', method: 'manual' });
    expect(detail.body.timeline.map((e: { event: string }) => e.event)).toContain(
      'Reclassified by reviewer',
    );
    // Reprocessing replaced (not duplicated) attachment records.
    expect(await Attachment.countDocuments({ orgId: owner.orgId, emailId: email.id })).toBe(
      detail.body.attachments.length,
    );
  });

  it('marks unreadable emails failed and lists them for admins', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const c = await t.loginAs(owner.email);
    await postRaw(await sampleEmail('pdf_po', ctx(await forwardingAddress(c))));
    const email = await InboundEmail.findOne({ orgId: owner.orgId });
    await t.storage.delete(email!.rawStorageKey); // the stored raw file is gone

    await t.drainJobs();
    expect((await c.get('/api/emails?view=failed')).body.total).toBe(1);
    const errors = await c.get('/api/processing-errors');
    expect(errors.body.items).toEqual([
      expect.objectContaining({
        jobName: 'process-email',
        entity: { type: 'email', id: email!._id.toString() },
      }),
    ]);
  });
});

describe('email tenant isolation', () => {
  it("org B cannot read, reclassify or download org A's emails", async () => {
    const a = await t.createUser({ role: 'owner' });
    const ca = await t.loginAs(a.email);
    await postRaw(await sampleEmail('pdf_po', ctx(await forwardingAddress(ca))));
    await t.drainJobs();
    const [email] = (await ca.get('/api/emails')).body.items;

    const b = await t.createUser({ role: 'owner' });
    const cb = await t.loginAs(b.email);
    expect((await cb.get('/api/emails')).body.total).toBe(0);
    expect((await cb.get(`/api/emails/${email.id}`)).status).toBe(404);
    expect(
      (await cb.post(`/api/emails/${email.id}/reclassify`, { label: 'not_order' })).status,
    ).toBe(404);
    expect((await cb.post(`/api/emails/${email.id}/reprocess`)).status).toBe(404);
  });
});

describe('dev test email', () => {
  it('sends a sample PO to the org forwarding address', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const c = await t.loginAs(owner.email);
    const res = await c.post('/api/dev/test-email', { scenario: 'pdf_po' });
    expect(res.status).toBe(201);
    await t.drainJobs();
    expect((await c.get('/api/emails?view=orders')).body.total).toBe(1);
  });
});
