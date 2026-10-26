import type { EmailClassification } from '@keyless/shared';
import type { ClassifyInput } from '../ingestion/classify';

export type LlmUsage = { inputTokens: number; outputTokens: number; costUsd: number };

export type LlmClassification = {
  label: EmailClassification;
  confidence: number;
  reason: string;
  model: string;
  usage: LlmUsage;
};

/**
 * Provider-agnostic LLM access. Every method returns validated, structured output plus usage
 * so cost can be tracked per org. M4 adds `extractOrder` (with vision input).
 */
export interface LlmProvider {
  readonly name: string;
  classifyEmail(input: ClassifyInput): Promise<LlmClassification>;
}
