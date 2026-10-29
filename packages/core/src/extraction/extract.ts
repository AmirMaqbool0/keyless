import {
  extractionOutputSchema,
  normalizeExtractionOutput,
  salvageOrders,
  type ExtractedOrderDto,
  type ExtractionDto,
} from '@keyless/shared';
import { prepareAttachment, prepareBody, type PreparedDocument } from '../documents/prepare';
import { logger } from '../lib/logger';
import { EXTRACTION_PROMPT_VERSION } from '../llm/prompts';
import { LlmRefusalError, type LlmProvider, type LlmUsage } from '../llm/types';
import { ruleExtract } from '../llm/ruleExtractor';
import type { AttachmentKind } from '../models/Attachment';
import { checkOrder } from './checks';

/*
 * Extraction for one email, independent of the database so the eval harness runs exactly the
 * same code as production. Order documents (PDF, image, spreadsheet, CSV) are read one by one;
 * the email body is used only when there is no document.
 */

export type SourceFile = {
  id?: string;
  filename: string;
  kind: AttachmentKind;
  isInline: boolean;
  content: Buffer;
};
export type EmailForExtraction = {
  subject: string;
  fromName?: string;
  fromAddress?: string;
  receivedAt: Date;
  text: string;
};

export type SourceExtraction = Omit<ExtractionDto, 'id' | 'createdAt'> & { pageCount: number };

const ORDER_KINDS: AttachmentKind[] = ['pdf', 'image', 'spreadsheet', 'csv'];
const zeroUsage = (): LlmUsage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0 });

/** Which parts of an email to read. */
export function extractionSources(files: SourceFile[]): SourceFile[] {
  return files.filter((f) => !f.isInline && ORDER_KINDS.includes(f.kind));
}

async function extractOne(
  llm: LlmProvider,
  doc: PreparedDocument,
  email: EmailForExtraction,
  hints: string[],
  source: SourceExtraction['source'],
  now: Date,
): Promise<SourceExtraction> {
  const started = Date.now();
  const base = {
    source,
    provider: llm.name,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    pageCount: doc.pageCount,
    documentNotes: null,
  };
  if (doc.unsupported) {
    return {
      ...base,
      status: 'failed',
      model: null,
      orders: [],
      error: doc.unsupported,
      usage: zeroUsage(),
      durationMs: 0,
      attempts: 0,
    };
  }
  if (doc.text === null && !llm.supportsVision) {
    return {
      ...base,
      status: 'needs_llm',
      model: null,
      orders: [],
      error:
        'This is a scan or photo. Reading it needs an AI model with vision: set LLM_PROVIDER=anthropic.',
      usage: zeroUsage(),
      durationMs: 0,
      attempts: 0,
    };
  }

  const usage = zeroUsage();
  let model: string | null = null;
  let retryFeedback: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await llm.extractOrder({
        document: doc,
        email: {
          subject: email.subject,
          fromName: email.fromName,
          fromAddress: email.fromAddress,
          receivedAt: email.receivedAt,
          bodyExcerpt: email.text,
        },
        hints,
        retryFeedback,
      });
      model = res.model;
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      usage.costUsd += res.usage.costUsd;
      const normalized = normalizeExtractionOutput(res.output);
      const parsed = extractionOutputSchema.safeParse(normalized);
      if (!parsed.success) {
        // Retry once, telling the model exactly what was wrong (spec section 6).
        const issueDescriptions = parsed.error.issues
          .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
          .join('; ');
        retryFeedback = `The output had schema validation errors: ${issueDescriptions}. Please use null for any missing or omitted fields (such as tax, part code, unit, price, totals) rather than omitting keys or returning unexpected types.`.slice(0, 1500);
        logger.warn({ source: source.label, attempt }, 'Extraction output failed validation');

        if (attempt === 2) {
          // Attempt 2 failed: salvage whatever lines are valid
          const salvaged = salvageOrders(res.output);
          if (salvaged.orders.length > 0) {
            const multiOrder = salvaged.orders.length > 1;
            const orders: ExtractedOrderDto[] = salvaged.orders.map((o) => {
              const checked = checkOrder(o, { now, documentText: doc.text, multiOrder });
              const issues = [...checked.issues];
              issues.push({
                code: 'partial_extraction',
                severity: 'warning',
                message: 'Some fields could not be read — please check against the document',
              });
              return {
                ...o,
                confidence: Math.min(checked.confidence, 0.6),
                issues,
              };
            });
            return {
              ...base,
              status: 'completed',
              model,
              orders,
              documentNotes:
                typeof (res.output as Record<string, unknown>)?.documentNotes === 'string'
                  ? ((res.output as Record<string, unknown>).documentNotes as string)
                  : null,
              error: null,
              usage,
              durationMs: Date.now() - started,
              attempts: 2,
            };
          }
        }
        continue;
      }
      const multiOrder = normalized.orders.length > 1;
      const orders: ExtractedOrderDto[] = normalized.orders.map((o) => ({
        ...o,
        ...checkOrder(o, { now, documentText: doc.text, multiOrder }),
      }));
      return {
        ...base,
        status: 'completed',
        model,
        orders,
        documentNotes: normalized.documentNotes,
        error: null,
        usage,
        durationMs: Date.now() - started,
        attempts: attempt,
      };
    } catch (err) {
      if (err instanceof LlmRefusalError) {
        return {
          ...base,
          status: 'failed',
          model,
          orders: [],
          error: err.message,
          usage,
          durationMs: Date.now() - started,
          attempts: attempt,
        };
      }
      if (doc.text) {
        logger.warn(
          { err, source: source.label, attempt },
          'LLM extraction failed; falling back to rule-based extractor',
        );
        const fallback = ruleExtract(doc.text, {
          fromName: email.fromName,
          fromAddress: email.fromAddress,
          isBody: source.kind === 'body',
          subject: email.subject,
          emailText: email.text,
        });
        const normalized = normalizeExtractionOutput(fallback);
        if (normalized.orders.length > 0) {
          const multiOrder = normalized.orders.length > 1;
          const orders: ExtractedOrderDto[] = normalized.orders.map((o) => {
            const checked = checkOrder(o, { now, documentText: doc.text, multiOrder });
            const issues = [...checked.issues];
            issues.push({
              code: 'llm_fallback',
              severity: 'info',
              message: 'Extracted using deterministic rule engine. Please verify lines before approval.',
            });
            return {
              ...o,
              confidence: checked.confidence,
              issues,
            };
          });
          return {
            ...base,
            status: 'completed',
            model: 'rules-fallback',
            orders,
            documentNotes: normalized.documentNotes,
            error: null,
            usage,
            durationMs: Date.now() - started,
            attempts: attempt,
          };
        }
      }
      throw err; // transient (network, 5xx): let the job retry with backoff
    }
  }
  const technicalError =
    `The model's answer did not match the expected format twice: ${retryFeedback ?? ''}`.slice(
      0,
      2000,
    );
  return {
    ...base,
    status: 'failed',
    model,
    orders: [],
    error: "We couldn't read this document fully. Please check the lines against the original.",
    technicalError,
    usage,
    durationMs: Date.now() - started,
    attempts: 2,
  };
}

export async function extractEmail(
  llm: LlmProvider,
  input: { email: EmailForExtraction; files: SourceFile[]; hints?: string[]; now?: Date },
): Promise<SourceExtraction[]> {
  const now = input.now ?? new Date();
  const hints = input.hints ?? [];
  const docs = extractionSources(input.files);
  const results: SourceExtraction[] = [];

  if (!docs.length) {
    const body = prepareBody(input.email.subject, input.email.text);
    results.push(
      await extractOne(
        llm,
        body,
        input.email,
        hints,
        { kind: 'body', label: 'Email body', attachmentId: null, mode: 'text' },
        now,
      ),
    );
  }
  for (const file of docs) {
    const doc = await prepareAttachment(file);
    results.push(
      await extractOne(
        llm,
        doc,
        input.email,
        hints,
        { kind: 'attachment', label: file.filename, attachmentId: file.id ?? null, mode: doc.mode },
        now,
      ),
    );
  }

  // The same PO sent twice (say, PDF and spreadsheet copies) is flagged, not silently merged.
  const seen = new Map<string, string>();
  for (const r of results) {
    for (const o of r.orders) {
      const key = o.poNumber?.trim().toUpperCase();
      if (!key) continue;
      const first = seen.get(key);
      if (first)
        o.issues.push({
          code: 'duplicate_in_email',
          severity: 'warning',
          message: `PO ${o.poNumber} also appears in ${first}`,
        });
      else seen.set(key, r.source.label);
    }
  }
  return results;
}
