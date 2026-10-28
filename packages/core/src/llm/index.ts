import { env } from '../config/env';
import { AgentRouterProvider } from './agentrouter';
import { AnthropicProvider } from './anthropic';
import { MockLlmProvider } from './mock';
import type { LlmProvider } from './types';

export * from './types';

export function createLlmProvider(
  name: 'mock' | 'anthropic' | 'agentrouter' = env.LLM_PROVIDER,
): LlmProvider {
  if (name === 'agentrouter') {
    const key = env.AGENTROUTER_API_KEY || env.ANTHROPIC_API_KEY || '';
    const baseUrl = env.AGENTROUTER_BASE_URL || env.ANTHROPIC_BASE_URL || 'https://agentrouter.org';
    return new AgentRouterProvider(
      key,
      {
        extraction: env.LLM_MODEL_EXTRACTION,
        classify: env.LLM_MODEL_CLASSIFY,
      },
      baseUrl,
    );
  }
  if (name === 'anthropic') {
    return new AnthropicProvider(
      env.ANTHROPIC_API_KEY,
      {
        extraction: env.LLM_MODEL_EXTRACTION,
        classify: env.LLM_MODEL_CLASSIFY,
      },
      env.ANTHROPIC_BASE_URL,
    );
  }
  return new MockLlmProvider();
}
