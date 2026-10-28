import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { EMAIL_CLASSIFICATIONS, extractionOutputSchema } from '@keyless/shared';
import { logger } from '../lib/logger';
import type { ClassifyInput } from '../ingestion/classify';
import { knownModel, usageCost } from './pricing';
import { CLASSIFY_SYSTEM_PROMPT, EXTRACTION_SYSTEM_PROMPT, extractionUserText } from './prompts';
import {
  LlmRefusalError,
  type ExtractInput,
  type LlmClassification,
  type LlmExtraction,
  type LlmProvider,
} from './types';

/*
 * Claude via the official SDK (patterns per the claude-api skill, SDK 0.135):
 *  - structured output with output_config.format + betaZodOutputFormat, read from parsed_output
 *  - PDFs as base64 `document` blocks and photos as `image` blocks (vision) when there is no
 *    usable text layer
 *  - server-side refusal fallbacks (`fallbacks: "default"`) so a safety decline is retried on
 *    another model inside the same call; a refusal that survives that is surfaced, not retried
 *  - the stable system prompt is prompt-cached
 */

const DEFAULT_MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const classificationSchema = z.object({
  label: z.enum(EMAIL_CLASSIFICATIONS),
  confidence: z.number(),
  reason: z.string(),
});

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly supportsVision = true;
  private readonly client: Anthropic;

  constructor(
    apiKey: string | undefined,
    private readonly models: { extraction?: string; classify?: string } = {},
    baseURL?: string,
  ) {
    // SDK retries 408/409/429/5xx itself; our job queue adds slower retries on top.
    this.client = new Anthropic({ apiKey, baseURL, maxRetries: 3, timeout: 5 * 60_000 });
    for (const m of [this.extractionModel, this.classifyModel]) {
      if (!knownModel(m))
        logger.warn(`No price on file for model ${m}; its cost will be recorded as 0`);
    }
  }

  private get extractionModel() {
    return this.models.extraction ?? DEFAULT_MODEL;
  }

  private get classifyModel() {
    return this.models.classify ?? DEFAULT_MODEL;
  }

  async extractOrder(input: ExtractInput): Promise<LlmExtraction> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (input.document.text === null && input.document.pdf) {
      content.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: input.document.pdf.toString('base64'),
        },
      });
    } else if (input.document.text === null && input.document.image) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: input.document.image.mediaType,
          data: input.document.image.data.toString('base64'),
        },
      });
    }
    content.push({ type: 'text', text: extractionUserText(input) });

    const response = await this.client.beta.messages.parse({
      model: this.extractionModel,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      // Careful reading of messy documents benefits from thinking; medium keeps cost sane.
      output_config: { effort: 'medium', format: betaZodOutputFormat(extractionOutputSchema) },
      system: [
        { type: 'text', text: EXTRACTION_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content }],
    });
    this.assertUsable(response.stop_reason, response.stop_details?.explanation);
    return {
      output: response.parsed_output,
      model: response.model,
      usage: usageCost(response.model, response.usage),
    };
  }

  async classifyEmail(input: ClassifyInput): Promise<LlmClassification> {
    const attachments = input.attachments
      .filter((a) => !a.isInline)
      .map((a) => `${a.filename} (${a.kind})`);
    const response = await this.client.beta.messages.parse({
      model: this.classifyModel,
      max_tokens: 4000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(classificationSchema) },
      system: [
        { type: 'text', text: CLASSIFY_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: `From: ${input.from ?? 'unknown'}\nSubject: ${input.subject}\nAttachments: ${attachments.join(', ') || 'none'}\n\n${input.text.slice(0, 4000)}`,
        },
      ],
    });
    this.assertUsable(response.stop_reason, response.stop_details?.explanation);
    const out = classificationSchema.parse(response.parsed_output);
    return {
      label: out.label,
      confidence: Math.min(1, Math.max(0, out.confidence)),
      reason: out.reason,
      model: response.model,
      usage: usageCost(response.model, response.usage),
    };
  }

  private assertUsable(stopReason: string | null, refusalExplanation?: string | null): void {
    if (stopReason === 'refusal') {
      throw new LlmRefusalError(
        `The model declined to process this document${refusalExplanation ? `: ${refusalExplanation}` : ''}`,
      );
    }
    if (stopReason === 'max_tokens')
      throw new Error('The model ran out of output tokens (document too long?)');
  }
}
