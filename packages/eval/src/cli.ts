/**
 * pnpm eval [--provider mock|anthropic] [--filter text] [--ci] [--update-baseline]
 *
 * Runs extraction on every fixture, prints accuracy, cost and latency, and writes an HTML report
 * to packages/eval/reports/. With --ci, exits 1 if any metric is below the stored baseline for
 * that provider (minus a small tolerance).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// The core config validates server settings the eval never uses; give it harmless values so the
// eval runs anywhere (CI included). A real .env, if present, still wins for API keys.
process.env.MONGO_URI ??= 'mongodb://unused/eval';
process.env.JWT_SECRET ??= 'eval-only-secret-not-used-for-anything-real';
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.LOG_LEVEL ??= 'warn';

const { values } = parseArgs({
  options: {
    provider: { type: 'string' },
    filter: { type: 'string' },
    ci: { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
    'update-baseline': { type: 'boolean', default: false },
  },
});

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixturesDir = path.join(root, 'fixtures');
const reportsDir = path.join(root, 'reports');
const baselinePath = path.join(root, 'baseline.json');
/** Allowed drop below baseline before CI fails (absolute, e.g. 0.02 = 2 points). */
const TOLERANCE = 0.02;
const GATED = [
  'headerAccuracy',
  'lineFieldAccuracy',
  'lineRecall',
  'linePrecision',
  'orderRecall',
] as const;

const { env } = await import('@keyless/core/config/env');
const { createLlmProvider } = await import('@keyless/core/llm/index');
const { loadFixtures, runFixture } = await import('./run');
const { htmlReport, totals } = await import('./report');

const providerName = (values.provider ?? env.LLM_PROVIDER) as 'mock' | 'anthropic';
if (providerName === 'anthropic' && !env.ANTHROPIC_API_KEY) {
  console.error('LLM provider "anthropic" needs ANTHROPIC_API_KEY (in .env or the environment).');
  process.exit(2);
}
const llm = createLlmProvider(providerName);
const fixtures = loadFixtures(fixturesDir, values.filter);
if (!fixtures.length) {
  console.error('No fixtures found. Run: pnpm --filter @keyless/eval generate');
  process.exit(2);
}

console.log(`Running ${fixtures.length} fixtures with provider "${llm.name}"...\n`);
const runs = [];
for (const { dir, fixture } of fixtures) {
  const run = await runFixture(fixturesDir, dir, fixture, llm);
  runs.push(run);
  const s = run.score;
  const pctOf = (t: { ok: number; total: number }) =>
    t.total ? `${Math.round((t.ok / t.total) * 100)}%` : '-';
  const status = run.error ? `ERROR ${run.error}` : run.extractions.map((x) => x.status).join(',');
  console.log(
    `${s.perfect ? '✓' : '·'} ${dir.padEnd(28)} header ${pctOf(s.header).padStart(4)}  lines ${pctOf(s.lineFields).padStart(4)}  found ${pctOf(s.lineRecall).padStart(4)}  ${String(run.latencyMs).padStart(6)} ms  ${status}`,
  );
  if (values.verbose) {
    const show = (v: unknown) => JSON.stringify(v ?? null);
    for (const o of run.orders) {
      if (o.expected && !o.actual) console.log(`    missing order ${o.expected.poNumber}`);
      if (!o.expected && o.actual) console.log(`    extra order ${o.actual.poNumber}`);
      for (const f of o.header.filter((x) => !x.ok))
        console.log(`    ${f.field}: expected ${show(f.expected)} got ${show(f.actual)}`);
      for (const l of o.lines) {
        if (l.expected && !l.actual)
          console.log(
            `    missed line ${show(l.expected.customerPartCode)} ${show(l.expected.description)}`,
          );
        if (!l.expected && l.actual)
          console.log(
            `    extra line ${show(l.actual.customerPartCode)} ${show(l.actual.description)}`,
          );
        for (const f of l.fields.filter((x) => !x.ok))
          console.log(
            `    line ${l.expected?.customerPartCode ?? '?'} ${f.field}: expected ${show(f.expected)} got ${show(f.actual)}`,
          );
      }
    }
  }
}

const t = totals(runs);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
console.log(`
Header field accuracy   ${pct(t.headerAccuracy)}
Line field accuracy     ${pct(t.lineFieldAccuracy)}
Lines found (recall)    ${pct(t.lineRecall)}
Lines correct (prec.)   ${pct(t.linePrecision)}
Orders found            ${pct(t.orderRecall)}
Perfect documents       ${pct(t.perfectDocs)}
SKU match accuracy      n/a until M5 (matching)
Cost                    $${t.costUsd.toFixed(4)} total, $${t.costPerDoc.toFixed(4)} per document
Median latency          ${t.medianLatencyMs} ms`);

fs.mkdirSync(reportsDir, { recursive: true });
const now = new Date();
const htmlPath = path.join(reportsDir, `report-${llm.name}.html`);
fs.writeFileSync(htmlPath, htmlReport(llm.name, runs, t, now));
fs.writeFileSync(
  path.join(reportsDir, `latest-${llm.name}.json`),
  JSON.stringify(
    {
      provider: llm.name,
      at: now.toISOString(),
      totals: t,
      fixtures: runs.map((r) => ({
        dir: r.dir,
        score: r.score,
        costUsd: r.costUsd,
        latencyMs: r.latencyMs,
        error: r.error,
      })),
    },
    null,
    2,
  ),
);
console.log(`\nReport: ${htmlPath}`);

type Baseline = Record<string, Partial<Record<(typeof GATED)[number], number>>>;
const baseline: Baseline = fs.existsSync(baselinePath)
  ? (JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as Baseline)
  : {};

if (values['update-baseline']) {
  if (values.filter) {
    console.error('Refusing to update the baseline from a filtered run.');
    process.exit(2);
  }
  baseline[llm.name] = Object.fromEntries(GATED.map((k) => [k, Math.floor(t[k] * 1000) / 1000]));
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`Baseline for "${llm.name}" updated.`);
}

if (values.ci) {
  const base = baseline[llm.name];
  if (!base) {
    console.error(
      `No baseline for "${llm.name}" in baseline.json; run with --update-baseline first.`,
    );
    process.exit(1);
  }
  const failures = GATED.filter((k) => base[k] !== undefined && t[k] < base[k]! - TOLERANCE);
  if (failures.length) {
    console.error(
      `\nAccuracy dropped below baseline: ${failures.map((k) => `${k} ${pct(t[k])} < ${pct(base[k]!)}`).join(', ')}`,
    );
    process.exit(1);
  }
  console.log('\nAll metrics at or above baseline.');
}
