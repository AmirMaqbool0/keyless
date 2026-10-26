import { env } from '../config/env';
import { AnthropicProvider } from './anthropic';
import { MockLlmProvider } from './mock';
import type { LlmProvider } from './types';

export * from './types';

export function createLlmProvider(name: 'mock' | 'anthropic' = env.LLM_PROVIDER): LlmProvider {
  if (name === 'anthropic') {
    return new AnthropicProvider(env.ANTHROPIC_API_KEY, {
      extraction: env.LLM_MODEL_EXTRACTION,
      classify: env.LLM_MODEL_CLASSIFY,
    });
  }
  return new MockLlmProvider();
}
