import type { EmailClassification } from '@keyless/shared';

/**
 * Cheap, explainable first-pass classification. Strong signals settle the label on their own;
 * anything below HEURISTIC_CONFIDENT goes to the LLM for a second opinion.
 */
export const HEURISTIC_CONFIDENT = 0.8;

export type ClassifyInput = {
  subject: string;
  text: string;
  from?: string;
  headers: Record<string, string>;
  attachments: { filename: string; kind: string; isInline: boolean }[];
};

export type ClassifyResult = { label: EmailClassification; confidence: number; reasons: string[] };

const ORDER_FILE = /(^|[^a-z])(p\.?o|purchase[\s_-]*order|order|ordr|requisition)([^a-z]|$)/i;
const ORDER_SUBJECT =
  /\b(p\.?o\.?\s*(no\.?|number|#)?\s*[:#-]?\s*\w*\d|purchase\s+order|new\s+order|order\s*(no\.?|number|#|ref)|our\s+order|please\s+(supply|send|deliver)|order\b)/i;
const CANCEL =
  /\bcancel(?:l?ed|lation|ling)?\b|\bplease\s+(?:do\s+not|don'?t)\s+(?:send|ship|process)\b/i;
const AMEND =
  /\b(amend(?:ed|ment)?|revised|revision|rev\s*\d|change[sd]?\s+(?:to|on)\s+(?:our\s+)?(?:order|po)|update[sd]?\s+(?:to\s+)?(?:our\s+)?(?:order|po)|add\s+to\s+(?:our\s+)?(?:order|po)|replace(?:s|ment)?\s+(?:order|po))\b/i;
const QUOTE =
  /\b(quote|quotation|rfq|price\s+(?:check|request|list)|pricing\s+for|could\s+you\s+price|how\s+much\s+(?:is|are|would))\b/i;
const DELIVERY =
  /\b(where\s+is\s+(?:our|my)|tracking|eta\b|not\s+(?:yet\s+)?(?:arrived|received|been\s+delivered)|chas(?:e|ing)|proof\s+of\s+delivery|\bpod\b|missing\s+items?|short\s+delivered|delivery\s+(?:date|update|status|query))/i;
const ORDER_LINE =
  /^\s*(?:\d+\s*(?:x|\*|of|qty|pcs|cases?|boxes?|ea(?:ch)?)?\s+[\w-]{3,}|[\w-]{3,}\s*[-:,x]\s*\d+\s*(?:x|pcs|cases?|boxes?|ea(?:ch)?)?)\b/gim;
const AUTO_REPLY_SUBJECT =
  /^(automatic\s+reply|auto(?:matic)?[-\s]?reply|out\s+of\s+(?:the\s+)?office|auto:|undeliverable|delivery\s+status\s+notification|mail\s+delivery\s+(?:failed|failure))/i;

export function classifyHeuristically(input: ClassifyInput): ClassifyResult {
  const h = input.headers;
  const subject = input.subject.trim();
  const body = input.text.slice(0, 4000);
  const top = `${subject}\n${body.slice(0, 600)}`;
  const files = input.attachments.filter((a) => !a.isInline);
  const docFiles = files.filter((a) =>
    ['pdf', 'spreadsheet', 'csv', 'image', 'document'].includes(a.kind),
  );
  const orderFiles = docFiles.filter((a) => ORDER_FILE.test(a.filename));

  // 1. Machine-generated mail is never an order, except auto-forwarded messages (which are forwarded orders)
  const autoSubmittedVal = (h['auto-submitted'] || '').toLowerCase().trim();
  const isAutoSubmitted =
    autoSubmittedVal && autoSubmittedVal !== 'no' && autoSubmittedVal !== 'auto-forwarded';
  const isAutoReply =
    isAutoSubmitted ||
    h['x-autoreply'] ||
    h['x-autorespond'] ||
    AUTO_REPLY_SUBJECT.test(subject);

  if (isAutoReply && orderFiles.length === 0) {
    return {
      label: 'not_order',
      confidence: 0.95,
      reasons: ['Automatic reply or delivery notification'],
    };
  }
  if (/^(mailer-daemon|postmaster)@/i.test(input.from ?? '')) {
    return { label: 'not_order', confidence: 0.95, reasons: ['Bounce message'] };
  }
  if (h['list-unsubscribe'] || /^(bulk|list|junk)$/i.test(h.precedence ?? '')) {
    return { label: 'not_order', confidence: 0.9, reasons: ['Newsletter or mailing list'] };
  }

  // 2. A user deliberately uploaded a document as an order.
  if (h['x-keyless-source'] === 'upload-document') {
    return { label: 'new_order', confidence: 0.9, reasons: ['Uploaded to Keyless as an order'] };
  }

  const mentionsOrder = /\b(order|p\.?o\.?|purchase)\b/i.test(top);

  // 3. Changes to existing orders beat "new order" when both appear.
  if (CANCEL.test(subject) || (CANCEL.test(body.slice(0, 600)) && mentionsOrder)) {
    return {
      label: 'cancellation',
      confidence: CANCEL.test(subject) ? 0.85 : 0.7,
      reasons: ['Mentions cancelling an order'],
    };
  }
  if (AMEND.test(subject) || (AMEND.test(body.slice(0, 600)) && mentionsOrder)) {
    return {
      label: 'amendment',
      confidence: AMEND.test(subject) ? 0.82 : 0.68,
      reasons: ['Mentions changing an existing order'],
    };
  }

  // 4. New orders.
  const orderLines = body.match(ORDER_LINE)?.length ?? 0;
  if (orderFiles.length) {
    return {
      label: 'new_order',
      confidence: 0.92,
      reasons: [`Order document attached: ${orderFiles[0]!.filename}`],
    };
  }
  if (ORDER_SUBJECT.test(subject) && docFiles.length) {
    return {
      label: 'new_order',
      confidence: 0.88,
      reasons: ['Order subject with a document attached'],
    };
  }
  if (QUOTE.test(top)) {
    return { label: 'quote_request', confidence: 0.8, reasons: ['Asks for a price or quotation'] };
  }
  if (DELIVERY.test(top) && !docFiles.length) {
    return { label: 'delivery_query', confidence: 0.75, reasons: ['Asks about a delivery'] };
  }
  if (ORDER_SUBJECT.test(subject) && orderLines >= 2) {
    return {
      label: 'new_order',
      confidence: 0.85,
      reasons: ['Order subject with item lines in the body'],
    };
  }
  if (orderLines >= 3) {
    return {
      label: 'new_order',
      confidence: 0.7,
      reasons: [`${orderLines} lines that look like order items`],
    };
  }
  if (ORDER_SUBJECT.test(subject)) {
    return { label: 'new_order', confidence: 0.65, reasons: ['Subject mentions an order'] };
  }
  if (docFiles.length) {
    return {
      label: 'new_order',
      confidence: 0.55,
      reasons: ['Has a document attached but no clear order wording'],
    };
  }
  return { label: 'not_order', confidence: 0.6, reasons: ['No order signals found'] };
}
