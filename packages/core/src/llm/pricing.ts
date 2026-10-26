import type { LlmUsage } from './types';

/**
 * USD per million tokens, from Anthropic's published first-party prices (cached 2026-10).
 * Cache writes bill at 1.25x input; cache reads as listed. Unknown models cost 0 and are logged
 * by the caller, so a new model never breaks extraction.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
};

export function knownModel(model: string): boolean {
  return model in PRICES;
}

export function usageCost(
  model: string,
  u: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  },
): LlmUsage {
  const p = PRICES[model];
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const inputTokens = u.input_tokens + cacheWrite + cacheRead;
  if (!p) return { inputTokens, outputTokens: u.output_tokens, costUsd: 0 };
  const cost =
    (u.input_tokens * p.input +
      cacheWrite * p.input * 1.25 +
      cacheRead * p.cacheRead +
      u.output_tokens * p.output) /
    1_000_000;
  return { inputTokens, outputTokens: u.output_tokens, costUsd: Math.round(cost * 1e6) / 1e6 };
}
