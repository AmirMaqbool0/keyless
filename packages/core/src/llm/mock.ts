import { classifyHeuristically, type ClassifyInput } from '../ingestion/classify';
import { ruleExtract } from './ruleExtractor';
import type { ExtractInput, LlmClassification, LlmExtraction, LlmProvider } from './types';

/**
 * Offline stand-in for development, tests and CI: deterministic, free, no API key. Classification
 * reuses the heuristics; extraction uses the rule-based reader, which handles text-layer PDFs,
 * spreadsheets and email bodies but not scans or photos (supportsVision = false).
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  readonly supportsVision = false;

  async classifyEmail(input: ClassifyInput): Promise<LlmClassification> {
    const h = classifyHeuristically(input);
    return {
      label: h.label,
      confidence: Math.max(h.confidence, 0.6),
      reason: `Mock LLM (no API key configured): ${h.reasons[0] ?? 'no signals'}`,
      model: 'mock',
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
  }

  async extractOrder(input: ExtractInput): Promise<LlmExtraction> {
    const output = ruleExtract(input.document.text ?? '', {
      fromName: input.email.fromName,
      fromAddress: input.email.fromAddress,
      isBody: input.document.label === 'Email body',
      subject: input.email.subject,
      emailText: input.email.bodyExcerpt,
    });
    return { output, model: 'rules-v1', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }
}
