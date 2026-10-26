import { classifyHeuristically, type ClassifyInput } from '../ingestion/classify';
import type { LlmClassification, LlmProvider } from './types';

/**
 * Offline stand-in for development and tests: deterministic, free, no API key. It reuses the
 * heuristics, so it never disagrees with them; real second opinions need a real provider.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';

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
}
