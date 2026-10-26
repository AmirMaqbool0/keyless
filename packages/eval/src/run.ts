import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { extractEmail, type SourceExtraction } from '@keyless/core/extraction/extract';
import type { LlmProvider } from '@keyless/core/llm/types';
import { attachmentKind } from '@keyless/core/models/Attachment';
import { scoreOrders, summarise, type FixtureScore, type OrderResult } from './score';
import type { Fixture } from './types';

export type FixtureRun = {
  dir: string;
  fixture: Fixture;
  extractions: SourceExtraction[];
  orders: OrderResult[];
  score: FixtureScore;
  costUsd: number;
  latencyMs: number;
  error: string | null;
};

export function loadFixtures(root: string, filter?: string): { dir: string; fixture: Fixture }[] {
  return fs
    .readdirSync(root)
    .filter((d) => fs.existsSync(path.join(root, d, 'expected.json')))
    .filter((d) => !filter || d.includes(filter))
    .sort()
    .map((d) => ({
      dir: d,
      fixture: JSON.parse(fs.readFileSync(path.join(root, d, 'expected.json'), 'utf8')) as Fixture,
    }));
}

/** Runs the production extraction code (minus the database) on one fixture email. */
export async function runFixture(
  root: string,
  dir: string,
  fixture: Fixture,
  llm: LlmProvider,
): Promise<FixtureRun> {
  const started = Date.now();
  const parsed = await simpleParser(fs.readFileSync(path.join(root, dir, 'email.eml')));
  const from = parsed.from?.value[0];
  const receivedAt = parsed.date ?? new Date();
  try {
    const extractions = await extractEmail(llm, {
      email: {
        subject: parsed.subject ?? '',
        fromName: from?.name,
        fromAddress: from?.address,
        receivedAt,
        text: parsed.text ?? '',
      },
      files: parsed.attachments.map((a) => ({
        filename: a.filename ?? 'attachment',
        kind: attachmentKind(a.filename ?? '', a.contentType),
        isInline: Boolean(a.related),
        content: a.content,
      })),
      // Judge dates against the day the order was sent, not the day the eval runs.
      now: receivedAt,
    });
    const actual = extractions.flatMap((x) => x.orders);
    const orders = scoreOrders(fixture.orders, actual);
    return {
      dir,
      fixture,
      extractions,
      orders,
      score: summarise(orders),
      costUsd: extractions.reduce((c, x) => c + x.usage.costUsd, 0),
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    const orders = scoreOrders(fixture.orders, []);
    return {
      dir,
      fixture,
      extractions: [],
      orders,
      score: summarise(orders),
      costUsd: 0,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
