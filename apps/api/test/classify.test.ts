import { describe, expect, it } from 'vitest';
import { classifyHeuristically, type ClassifyInput } from '@keyless/core/ingestion/classify';

const email = (over: Partial<ClassifyInput>): ClassifyInput => ({
  subject: '',
  text: '',
  headers: {},
  attachments: [],
  ...over,
});
const pdf = (filename: string) => ({ filename, kind: 'pdf', isInline: false });

describe('heuristic email classification', () => {
  it.each([
    [
      'PO PDF attached',
      email({ subject: 'Hello', attachments: [pdf('PO-12345.pdf')] }),
      'new_order',
      0.9,
    ],
    [
      'purchase order subject + spreadsheet',
      email({
        subject: 'Purchase Order 4471',
        attachments: [{ filename: 'export.xlsx', kind: 'spreadsheet', isInline: false }],
      }),
      'new_order',
      0.85,
    ],
    [
      'order lines in the body',
      email({
        subject: 'Order for Friday',
        text: 'Please send:\n10 x GL1001 gloves\n5 x BL2002 sacks\n2 x CH1003 bleach',
      }),
      'new_order',
      0.8,
    ],
    [
      'amendment',
      email({ subject: 'RE: PO 4471 - amendment', attachments: [pdf('PO-4471.pdf')] }),
      'amendment',
      0.8,
    ],
    [
      'cancellation beats new order',
      email({ subject: 'Cancel order 4471', attachments: [pdf('PO-4471.pdf')] }),
      'cancellation',
      0.8,
    ],
    [
      'quote request',
      email({ subject: 'Price request', text: 'Could you price up 100 boxes of gloves?' }),
      'quote_request',
      0.8,
    ],
    [
      'delivery query',
      email({ subject: 'Where is our delivery?', text: 'Order 4471 has not arrived yet' }),
      'delivery_query',
      0.7,
    ],
    [
      'out of office',
      email({ subject: 'Automatic reply: PO 4471', attachments: [pdf('PO-4471.pdf')] }),
      'not_order',
      0.9,
    ],
    [
      'auto-submitted header',
      email({ subject: 'Order 4471', headers: { 'auto-submitted': 'auto-replied' } }),
      'not_order',
      0.9,
    ],
    [
      'newsletter',
      email({ subject: 'Our new spring range', headers: { 'list-unsubscribe': '<mailto:x@y>' } }),
      'not_order',
      0.9,
    ],
    [
      'uploaded document',
      email({ subject: 'Uploaded: scan.jpg', headers: { 'x-keyless-source': 'upload-document' } }),
      'new_order',
      0.9,
    ],
    [
      'nothing order-like',
      email({ subject: 'Lunch on Friday?', text: 'Are you free?' }),
      'not_order',
      0.5,
    ],
  ] as const)('%s', (_name, input, label, minConfidence) => {
    const result = classifyHeuristically(input);
    expect(result.label).toBe(label);
    expect(result.confidence).toBeGreaterThanOrEqual(minConfidence);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('ignores inline signature images when looking for order documents', () => {
    const result = classifyHeuristically(
      email({
        subject: 'Hi',
        attachments: [{ filename: 'order-logo.png', kind: 'image', isInline: true }],
      }),
    );
    expect(result.label).toBe('not_order');
  });

  it('is unsure (sends to the LLM) when only a vague document is attached', () => {
    const result = classifyHeuristically(
      email({ subject: 'Documents', attachments: [pdf('scan0001.pdf')] }),
    );
    expect(result).toMatchObject({ label: 'new_order' });
    expect(result.confidence).toBeLessThan(0.8);
  });
});
