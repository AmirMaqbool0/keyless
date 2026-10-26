import type { EmailClassification, ExtractionOutput } from '@keyless/shared';
import type { PreparedDocument } from '../documents/prepare';
import type { ClassifyInput } from '../ingestion/classify';

export type LlmUsage = { inputTokens: number; outputTokens: number; costUsd: number };

export type LlmClassification = {
  label: EmailClassification;
  confidence: number;
  reason: string;
  model: string;
  usage: LlmUsage;
};

export type ExtractInput = {
  document: PreparedDocument;
  email: {
    subject: string;
    fromName?: string;
    fromAddress?: string;
    receivedAt: Date;
    bodyExcerpt: string;
  };
  /** Learned per-customer hints, e.g. "their codes are in the second column". */
  hints: string[];
  /** Set on the single retry after the first answer failed validation. */
  retryFeedback?: string;
};

export type LlmExtraction = {
  /** Unvalidated: the caller validates it against extractionOutputSchema. */
  output: unknown;
  model: string;
  usage: LlmUsage;
};

/** The model declined (safety classifiers). Not retryable as-is. */
export class LlmRefusalError extends Error {}

/**
 * Provider-agnostic LLM access. Every call returns structured output plus usage so cost can be
 * tracked per org.
 */
export interface LlmProvider {
  readonly name: string;
  /** Can read scanned PDFs and photos. */
  readonly supportsVision: boolean;
  classifyEmail(input: ClassifyInput): Promise<LlmClassification>;
  extractOrder(input: ExtractInput): Promise<LlmExtraction>;
}

export type { ExtractionOutput };
