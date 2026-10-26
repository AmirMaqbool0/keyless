import { env } from '../config/env';
import { MockLlmProvider } from './mock';
import type { LlmProvider } from './types';

export * from './types';

export function createLlmProvider(): LlmProvider {
  if (env.LLM_PROVIDER === 'anthropic') {
    // TODO(M4): AnthropicProvider (structured output + vision for extraction).
    throw new Error('LLM_PROVIDER=anthropic arrives in M4; use LLM_PROVIDER=mock for now');
  }
  return new MockLlmProvider();
}
