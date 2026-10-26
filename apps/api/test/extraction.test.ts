import { describe, expect, it } from 'vitest';
import type { ExtractedOrder } from '@keyless/shared';
import { purchaseOrderPdf, sampleEmail, type SampleContext } from '@keyless/core/demo/sampleEmails';
import { checkOrder } from '@keyless/core/extraction/checks';
import { extractEmail } from '@keyless/core/extraction/extract';
import { MockLlmProvider } from '@keyless/core/llm/mock';
import { parseDocDate } from '@keyless/core/llm/ruleExtractor';
import { LlmRefusalError, type LlmProvider } from '@keyless/core/llm/types';
import { Extraction } from '@keyless/core/models/Extraction';
import { UsageRecord } from '@keyless/core/models/UsageRecord';
import { useTestApp } from './helpers';
import request from 'supertest';

const t = useTestApp();

const ctx = (to: string): SampleContext => ({
  customerName: 'Brew Cafe',
  senderName: 'Sam Buyer',
  senderAddress: 'orders@brewcafe.example',
  to,
  poNumber: 'PO-4471',
  deliveryAddress: ['1 High Street', 'Leeds', 'LS1 4AB'],
  lines: [
    {
      code: 'GL1001',
      description: 'Nitrile Gloves Blue Medium (Box 100)',
      quantity: 10,
      unitPrice: 4.5,
    },
    { code: 'BL2002', description: 'Refuse Sacks Black (Case 200)', quantity: 4, unitPrice: 9.95 },
  ],
});

const order = (over: Partial<ExtractedOrder> = {}): ExtractedOrder => ({
  customer: { name: 'Brew Cafe', accountNumber: null, email: null },
  poNumber: 'PO-1',
  orderDate: '2026-10-20',
  requestedDeliveryDate: null,
  deliveryAddress: {
    line1: '1 High St',
    line2: null,
    city: 'Leeds',
    postcode: 'LS1 4AB',
    country: null,
  },
  notes: null,
  currency: 'GBP',
  lines: [
    {
      lineNo: 1,
      customerPartCode: 'A1',
      description: 'Gloves',
      quantity: 2,
      unit: null,
      unitPrice: 5,
      lineTotal: 10,
      confidence: { customerPartCode: 1, description: 1, quantity: 1, unitPrice: 1 },
    },
  ],
  documentTotals: { subtotal: 10, tax: 2, total: 12 },
  fieldConfidence: { customer: 1, poNumber: 1, orderDate: 1, deliveryAddress: 1 },
  ...over,
});

const NOW = new Date('2026-10-21T12:00:00Z');

describe('deterministic checks', () => {
  it('passes a consistent order with high confidence', () => {
    const r = checkOrder(order(), { now: NOW, documentText: null, multiOrder: false });
    expect(r.issues).toEqual([]);
    expect(r.confidence).toBeGreaterThan(0.95);
  });

  it('flags totals, quantities, dates and line counts, and lowers confidence', () => {
    const bad = order({
      poNumber: null,
      orderDate: '2026-02-30',
      requestedDeliveryDate: '2026-10-01',
      lines: [
        { ...order().lines[0]!, lineTotal: 11 },
        { ...order().lines[0]!, lineNo: 2, quantity: -1 },
      ],
      documentTotals: { subtotal: 50, tax: 1, total: 99 },
    });
    const r = checkOrder(bad, {
      now: NOW,
      documentText: 'Code | Description | Qty\nA1 | Gloves | 2\nB2 | Sacks | 1\nC3 | Bleach | 4',
      multiOrder: false,
    });
    expect([...new Set(r.issues.map((i) => i.code))].sort()).toEqual(
      [
        'delivery_in_past',
        'invalid_date',
        'invalid_quantity',
        'line_count_mismatch',
        'line_total_mismatch',
        'missing_po_number',
        'subtotal_mismatch',
        'total_mismatch',
      ].sort(),
    );
    expect(r.confidence).toBeLessThan(0.3);
  });

  it('parses UK and long-form dates', () => {
    expect(parseDocDate('03/04/2026')).toBe('2026-04-03');
    expect(parseDocDate('30th November 2026')).toBe('2026-11-30');
    expect(parseDocDate('Nov 3, 2026')).toBe('2026-11-03');
    expect(parseDocDate('31/02/2026')).toBeNull();
  });
});

describe('extraction pipeline', () => {
  it('reads an emailed PDF PO into structured orders (offline extractor)', async () => {
    const pdf = await purchaseOrderPdf(ctx('x@y.example'));
    const results = await extractEmail(new MockLlmProvider(), {
      email: {
        subject: 'Purchase Order PO-4471',
        fromAddress: 'orders@brewcafe.example',
        receivedAt: NOW,
        text: 'Please find attached our order.',
      },
      files: [{ filename: 'PO-4471.pdf', kind: 'pdf', isInline: false, content: pdf }],
      // The sample PDF is dated today.
      now: new Date(),
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: 'completed',
      source: { kind: 'attachment', mode: 'text' },
    });
    const [o] = results[0]!.orders;
    expect(o).toMatchObject({
      poNumber: 'PO-4471',
      customer: { name: 'Brew Cafe' },
      deliveryAddress: { line1: '1 High Street', postcode: 'LS1 4AB' },
      documentTotals: { subtotal: 84.8 },
    });
    expect(o!.lines.map((l) => [l.customerPartCode, l.quantity, l.unitPrice])).toEqual([
      ['GL1001', 10, 4.5],
      ['BL2002', 4, 9.95],
    ]);
    expect(o!.issues).toEqual([]);
  });

  it('retries once with the validation error, then gives up cleanly', async () => {
    const prompts: (string | undefined)[] = [];
    const flaky: LlmProvider = {
      name: 'fake',
      supportsVision: true,
      classifyEmail: () => Promise.reject(new Error('unused')),
      extractOrder: async (input) => {
        prompts.push(input.retryFeedback);
        return {
          output: { orders: 'nope' },
          model: 'fake-1',
          usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.001 },
        };
      },
    };
    const results = await extractEmail(flaky, {
      email: { subject: 'Order', receivedAt: NOW, text: '2 x A1 Gloves' },
      files: [],
      now: NOW,
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBeUndefined();
    expect(prompts[1]).toContain('orders');
    expect(results[0]).toMatchObject({
      status: 'failed',
      attempts: 2,
      usage: { inputTokens: 200, costUsd: 0.002 },
    });
  });

  it('records a refusal as failed without retrying, and scans as needing a vision model', async () => {
    const refusing: LlmProvider = {
      name: 'fake',
      supportsVision: true,
      classifyEmail: () => Promise.reject(new Error('unused')),
      extractOrder: () => Promise.reject(new LlmRefusalError('The model declined')),
    };
    const refused = await extractEmail(refusing, {
      email: { subject: 'Order', receivedAt: NOW, text: '2 x A1 Gloves' },
      files: [],
      now: NOW,
    });
    expect(refused[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: 'The model declined',
    });

    const photo = await extractEmail(new MockLlmProvider(), {
      email: { subject: 'Order', receivedAt: NOW, text: '' },
      files: [
        {
          filename: 'photo.png',
          kind: 'image',
          isInline: false,
          content: Buffer.from(
            '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b10000000049454e44ae426082',
            'hex',
          ),
        },
      ],
      now: NOW,
    });
    expect(photo[0]).toMatchObject({ status: 'needs_llm' });
    expect(photo[0]!.error).toContain('vision');
  });
});

describe('extraction in the app', () => {
  async function forwardingAddress(c: Awaited<ReturnType<typeof t.loginAs>>) {
    return (await c.get('/api/mailboxes')).body.items[0].address as string;
  }

  it('extracts new orders automatically and shows them on the email', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const c = await t.loginAs(owner.email);
    await request(t.app)
      .post('/webhooks/inbound')
      .set('Content-Type', 'message/rfc822')
      .set('X-Inbound-Secret', 'test-inbound-secret')
      .send(await sampleEmail('pdf_po', ctx(await forwardingAddress(c))));
    await t.drainJobs();

    const [item] = (await c.get('/api/emails')).body.items;
    expect(item.extraction).toEqual({
      status: 'completed',
      orderCount: 1,
      lineCount: 2,
      issueCount: 0,
    });
    const detail = await c.get(`/api/emails/${item.id}`);
    expect(detail.body.extractions).toHaveLength(1);
    expect(detail.body.extractions[0]).toMatchObject({
      status: 'completed',
      provider: 'mock',
      promptVersion: 'extract-v1',
      source: { label: 'PO-PO-4471.pdf' },
    });
    expect(detail.body.extractions[0].orders[0].poNumber).toBe('PO-4471');
    expect(detail.body.timeline.map((e: { event: string }) => e.event)).toContain('Extracted');

    const usage = await UsageRecord.findOne({ orgId: owner.orgId });
    expect(usage).toMatchObject({
      documentsExtracted: 1,
      ordersExtracted: 1,
      pagesProcessed: 1,
      llmCalls: 0,
    });
  });

  it('does not extract non-orders until a reviewer marks one as an order; re-extract replaces results', async () => {
    const owner = await t.createUser({ role: 'owner' });
    const viewer = await t.createUser({ role: 'viewer', orgId: owner.orgId });
    const c = await t.loginAs(owner.email);
    await request(t.app)
      .post('/webhooks/inbound')
      .set('Content-Type', 'message/rfc822')
      .set('X-Inbound-Secret', 'test-inbound-secret')
      .send(await sampleEmail('quote_request', ctx(await forwardingAddress(c))));
    await t.drainJobs();
    const [item] = (await c.get('/api/emails')).body.items;
    expect(item.extraction).toBeNull();

    await c.post(`/api/emails/${item.id}/reclassify`, { label: 'new_order' });
    await t.drainJobs();
    expect((await c.get(`/api/emails/${item.id}`)).body.extraction).toMatchObject({
      status: 'completed',
      orderCount: 1,
      lineCount: 2,
    });

    expect(
      (await (await t.loginAs(viewer.email)).post(`/api/emails/${item.id}/extract`)).status,
    ).toBe(403);
    expect((await c.post(`/api/emails/${item.id}/extract`)).body.extraction.status).toBe('running');
    await t.drainJobs();
    expect(await Extraction.countDocuments({ orgId: owner.orgId, emailId: item.id })).toBe(1);
  });
});
