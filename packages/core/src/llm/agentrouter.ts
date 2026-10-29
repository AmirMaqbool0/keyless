import { z } from 'zod';
import { EMAIL_CLASSIFICATIONS } from '@keyless/shared';
import type { ClassifyInput } from '../ingestion/classify';
import { CLASSIFY_SYSTEM_PROMPT, EXTRACTION_SYSTEM_PROMPT, extractionUserText } from './prompts';
import {
  type ExtractInput,
  type LlmClassification,
  type LlmExtraction,
  type LlmProvider,
} from './types';

const DEFAULT_MODEL = 'gpt-5.6-sol';

const classificationSchema = z.object({
  label: z.enum(EMAIL_CLASSIFICATIONS),
  confidence: z.number(),
  reason: z.string(),
});

export class AgentRouterProvider implements LlmProvider {
  readonly name = 'agentrouter';
  readonly supportsVision = true;

  constructor(
    private readonly apiKey: string,
    private readonly models: { extraction?: string; classify?: string } = {},
    private readonly baseUrl: string = 'https://agentrouter.org',
  ) {}

  private get extractionModel(): string {
    return this.models.extraction || DEFAULT_MODEL;
  }

  private get classifyModel(): string {
    return this.models.classify || DEFAULT_MODEL;
  }

  private async callResponsesApi(model: string, systemPrompt: string, userText: string): Promise<{
    text: string;
    model: string;
    usage: { inputTokens: number; outputTokens: number; costUsd: number };
  }> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/v1/responses`;

    const body = {
      model,
      input: [
        {
          role: 'system',
          content: `${systemPrompt}\n\nCRITICAL: Respond ONLY with a valid, raw JSON object. Do not include markdown code blocks, prefixes, or conversational text.`,
        },
        {
          role: 'user',
          content: userText,
        },
      ],
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': 'claude-cli/2.1.219 (external, sdk-cli)',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`AgentRouter call failed (${res.status}): ${errText}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        `AgentRouter at ${url} returned HTML (${res.status}) instead of JSON. Check your AGENTROUTER_BASE_URL: ${errText.slice(0, 150)}`,
      );
    }

    type ApiResponse = {
      output?: Array<{ type: string; content?: Array<{ text?: string }> }>;
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const data = (await res.json()) as ApiResponse;
    const msg = data.output?.find((o) => o.type === 'message');
    const rawText = msg?.content?.[0]?.text ?? '';

    // Calculate approximate cost (e.g. $3 / $15 per 1M tokens)
    const inTokens = data.usage?.input_tokens ?? 0;
    const outTokens = data.usage?.output_tokens ?? 0;
    const costUsd = Number(((inTokens * 0.000003) + (outTokens * 0.000015)).toFixed(6));

    return {
      text: rawText,
      model: data.model ?? model,
      usage: {
        inputTokens: inTokens,
        outputTokens: outTokens,
        costUsd,
      },
    };
  }

  private parseJsonFromText(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      // Attempt to extract JSON from markdown or surrounded text
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]);
      }
      throw new Error(`Failed to parse JSON response from AgentRouter: ${text.slice(0, 200)}`);
    }
  }

  async classifyEmail(input: ClassifyInput): Promise<LlmClassification> {
    const attachments = input.attachments
      .filter((a) => !a.isInline)
      .map((a) => `${a.filename} (${a.kind})`);

    const userText = `From: ${input.from ?? 'unknown'}\nSubject: ${input.subject}\nAttachments: ${attachments.join(', ') || 'none'}\n\n${input.text.slice(0, 4000)}`;

    const { text, model, usage } = await this.callResponsesApi(
      this.classifyModel,
      CLASSIFY_SYSTEM_PROMPT,
      userText,
    );

    const json = this.parseJsonFromText(text);
    const out = classificationSchema.parse(json);

    return {
      label: out.label,
      confidence: Math.min(1, Math.max(0, out.confidence)),
      reason: out.reason,
      model,
      usage,
    };
  }

  private normalizeExtractionOutput(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object') {
      return { orders: [], documentNotes: null };
    }

    const rawRecord = raw as Record<string, unknown>;
    const rawOrders = Array.isArray(rawRecord.orders)
      ? rawRecord.orders
      : rawRecord.order
        ? [rawRecord.order]
        : Array.isArray(raw)
          ? raw
          : [raw];

    const orders = rawOrders.map((rawOrder: unknown) => {
      const o = (rawOrder && typeof rawOrder === 'object' ? rawOrder : {}) as Record<string, unknown>;
      const custObj = (o.customer && typeof o.customer === 'object' ? o.customer : {}) as Record<string, unknown>;
      const customer = {
        name: (custObj.name ?? o.customerName ?? o.customer ?? null) as string | null,
        accountNumber: (custObj.accountNumber ?? o.accountNumber ?? null) as string | null,
        email: (custObj.email ?? o.email ?? null) as string | null,
      };

      const rawAddr = (o.deliveryAddress ?? o.address ?? {}) as Record<string, unknown>;
      const rawAddrArr = Array.isArray(rawAddr) ? (rawAddr as unknown[]) : null;
      const deliveryAddress = {
        line1: (rawAddr.line1 ?? rawAddr.street ?? rawAddrArr?.[0] ?? null) as string | null,
        line2: (rawAddr.line2 ?? rawAddrArr?.[1] ?? null) as string | null,
        city: (rawAddr.city ?? rawAddrArr?.[2] ?? null) as string | null,
        postcode: (rawAddr.postcode ?? rawAddr.zip ?? rawAddrArr?.[3] ?? null) as string | null,
        country: (rawAddr.country ?? null) as string | null,
      };

      const rawTotals = (o.documentTotals ?? o.totals ?? {}) as Record<string, unknown>;
      const subtotal = typeof rawTotals.subtotal === 'number'
        ? rawTotals.subtotal
        : (parseFloat(String(rawTotals.subtotal ?? '')) || null);
      const total = typeof rawTotals.total === 'number'
        ? rawTotals.total
        : (parseFloat(String(rawTotals.total ?? '')) || null);
      const tax = typeof rawTotals.tax === 'number'
        ? rawTotals.tax
        : rawTotals.tax != null
          ? (parseFloat(String(rawTotals.tax)) || null)
          : (subtotal != null && total != null ? Number(Math.max(0, total - subtotal).toFixed(2)) : null);

      const fieldConf = (o.fieldConfidence ?? {}) as Record<string, unknown>;
      const fieldConfidence = {
        customer: typeof fieldConf.customer === 'number' ? fieldConf.customer : 0.95,
        poNumber: typeof fieldConf.poNumber === 'number' ? fieldConf.poNumber : 0.95,
        orderDate: typeof fieldConf.orderDate === 'number' ? fieldConf.orderDate : 0.95,
        deliveryAddress: typeof fieldConf.deliveryAddress === 'number' ? fieldConf.deliveryAddress : 0.95,
      };

      const rawLines = Array.isArray(o.lines) ? o.lines : Array.isArray(o.items) ? o.items : [];
      const lines = rawLines.map((rawLine: unknown, idx: number) => {
        const l = (rawLine && typeof rawLine === 'object' ? rawLine : {}) as Record<string, unknown>;
        const qty = typeof l.quantity === 'number' ? l.quantity : (parseFloat(String(l.quantity ?? l.qty ?? '')) || null);
        const price = typeof l.unitPrice === 'number' ? l.unitPrice : (parseFloat(String(l.unitPrice ?? l.price ?? '')) || null);
        const lineTotal = typeof l.lineTotal === 'number'
          ? l.lineTotal
          : (parseFloat(String(l.lineTotal ?? l.total ?? '')) || (qty != null && price != null ? Number((qty * price).toFixed(2)) : null));

        const partCode = (l.customerPartCode ?? l.partCode ?? l.itemCode ?? l.sku ?? l.code ?? null) as string | null;
        const desc = (l.description ?? l.desc ?? l.name ?? null) as string | null;

        const lineConf = (l.confidence ?? {}) as Record<string, unknown>;
        const confidence = {
          customerPartCode: typeof lineConf.customerPartCode === 'number' ? lineConf.customerPartCode : 0.95,
          description: typeof lineConf.description === 'number' ? lineConf.description : 0.95,
          quantity: typeof lineConf.quantity === 'number' ? lineConf.quantity : 0.95,
          unitPrice: typeof lineConf.unitPrice === 'number' ? lineConf.unitPrice : 0.95,
        };

        return {
          lineNo: typeof l.lineNo === 'number' ? l.lineNo : idx + 1,
          customerPartCode: partCode,
          description: desc,
          quantity: qty,
          unit: (l.unit ?? l.uom ?? null) as string | null,
          unitPrice: price,
          lineTotal,
          confidence,
        };
      });

      return {
        customer,
        poNumber: (o.poNumber ?? o.po_number ?? o.orderNumber ?? null) as string | null,
        orderDate: (o.orderDate ?? o.date ?? null) as string | null,
        requestedDeliveryDate: (o.requestedDeliveryDate ?? o.deliveryDate ?? null) as string | null,
        deliveryAddress,
        notes: (o.notes ?? o.specialInstructions ?? null) as string | null,
        currency: (o.currency ?? 'GBP') as string,
        lines,
        documentTotals: { subtotal, tax, total },
        fieldConfidence,
      };
    });

    return {
      orders,
      documentNotes: (rawRecord.documentNotes ?? null) as string | null,
    };
  }

  async extractOrder(input: ExtractInput): Promise<LlmExtraction> {
    const userText = extractionUserText(input);

    const promptWithSchema = `${EXTRACTION_SYSTEM_PROMPT}

CRITICAL OUTPUT FORMAT REQUIREMENTS:
You MUST respond with a JSON object with this exact shape:
{
  "orders": [
    {
      "customer": { "name": string | null, "accountNumber": string | null, "email": string | null },
      "poNumber": string | null,
      "orderDate": string | null,
      "requestedDeliveryDate": string | null,
      "deliveryAddress": { "line1": string | null, "line2": string | null, "city": string | null, "postcode": string | null, "country": string | null },
      "notes": string | null,
      "currency": string | null,
      "lines": [
        {
          "lineNo": number,
          "customerPartCode": string | null,
          "description": string | null,
          "quantity": number | null,
          "unit": string | null,
          "unitPrice": number | null,
          "lineTotal": number | null,
          "confidence": {
            "customerPartCode": number,
            "description": number,
            "quantity": number,
            "unitPrice": number
          }
        }
      ],
      "documentTotals": {
        "subtotal": number | null,
        "tax": number | null,
        "total": number | null
      },
      "fieldConfidence": {
        "customer": number,
        "poNumber": number,
        "orderDate": number,
        "deliveryAddress": number
      }
    }
  ],
  "documentNotes": string | null
}`;

    const { text, model, usage } = await this.callResponsesApi(
      this.extractionModel,
      promptWithSchema,
      userText,
    );

    const json = this.parseJsonFromText(text);
    const normalized = this.normalizeExtractionOutput(json);

    return {
      output: normalized,
      model,
      usage,
    };
  }
}
