import type { ExtractInput } from './types';

/** Bump when the extraction prompt or schema changes; stored on every extraction. */
export const EXTRACTION_PROMPT_VERSION = 'extract-v1';

/** Stable across requests so it can be prompt-cached. Never put per-request data here. */
export const EXTRACTION_SYSTEM_PROMPT = `You read purchase orders that customers email to a UK wholesale distributor and turn them into structured data. The distributor's staff will review your output before anything is ordered, and a wrong value costs them more than a missing one.

How to read the document:
- Report only what is on the document or in the email. If a value is not there, use null. Never guess, infer or fill in a value from general knowledge - a null is always better than an invented value.
- The customer is the business placing the order (the buyer). The distributor the order is addressed to is not the customer.
- Copy item codes exactly as printed, including dashes, slashes and leading zeros. They are the buyer's own codes and are matched later against a cross-reference table.
- Quantities and prices are numbers: drop currency symbols and thousands separators. A quantity like "2 cases" is quantity 2, unit "case".
- Dates are YYYY-MM-DD. UK documents write dates day-first: 03/04/2026 is 3 April 2026.
- If one document contains several separate purchase orders (several PO numbers, or one order per page), return one entry per order. Repeated page headers of a single multi-page order are one order.
- Lines that are not items (subtotals, VAT, delivery charges, notes) are not order lines. Report totals in documentTotals.
- Put delivery instructions (e.g. "deliver to rear entrance", "before 10am") in notes.
- If the document is not a purchase order at all, return an empty orders list.

Confidence (0 to 1) per field: 1 when the value is printed clearly, around 0.7 when you had to interpret layout or handwriting, below 0.5 when you are unsure. Use the confidence to flag your doubt instead of guessing.`;

export function extractionUserText(input: ExtractInput): string {
  const parts = [
    `Email subject: ${input.email.subject || '(none)'}`,
    `From: ${[input.email.fromName, input.email.fromAddress && `<${input.email.fromAddress}>`].filter(Boolean).join(' ') || '(unknown)'}`,
    `Received: ${input.email.receivedAt.toISOString().slice(0, 10)}`,
  ];
  if (input.document.label !== 'Email body' && input.email.bodyExcerpt.trim()) {
    parts.push(
      `Email message (for context; the order is in the attached document "${input.document.label}"):\n${input.email.bodyExcerpt.slice(0, 3000)}`,
    );
  }
  if (input.hints.length)
    parts.push(
      `Notes about this customer's documents:\n${input.hints.map((h) => `- ${h}`).join('\n')}`,
    );
  if (input.document.text !== null) {
    const what =
      input.document.mode === 'table'
        ? 'Spreadsheet contents (cells separated by |)'
        : input.document.label === 'Email body'
          ? 'Email body'
          : `Text of "${input.document.label}" (layout preserved; | marks column gaps)`;
    parts.push(`${what}:\n<document>\n${input.document.text}\n</document>`);
  } else {
    parts.push(`The order document "${input.document.label}" is attached above.`);
  }
  if (input.retryFeedback) {
    parts.push(
      `Your previous answer could not be used: ${input.retryFeedback}\nPlease answer again, following the schema exactly.`,
    );
  }
  parts.push('Extract the purchase order(s).');
  return parts.join('\n\n');
}

export const CLASSIFY_SYSTEM_PROMPT = `You sort the emails arriving in a UK wholesale distributor's orders mailbox. Choose exactly one label:
- new_order: a new purchase order (in an attachment or written in the email)
- amendment: changes an order already sent (quantities, items, dates)
- cancellation: cancels an order already sent
- quote_request: asks for prices or a quotation, not ordering yet
- delivery_query: asks about a delivery, missing items or proof of delivery
- not_order: anything else (invoices, statements, marketing, auto-replies, chat)
Give a confidence from 0 to 1 and a one-sentence reason a reviewer would find useful.`;
