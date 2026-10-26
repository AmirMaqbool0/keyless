import { rate, type Tally } from './score';
import type { FixtureRun } from './run';

export type Totals = {
  headerAccuracy: number;
  lineFieldAccuracy: number;
  lineRecall: number;
  linePrecision: number;
  orderRecall: number;
  perfectDocs: number;
  fixtures: number;
  costUsd: number;
  costPerDoc: number;
  medianLatencyMs: number;
  skuMatchAccuracy: null;
};

const add = (a: Tally, b: Tally): Tally => ({ ok: a.ok + b.ok, total: a.total + b.total });
const zero = (): Tally => ({ ok: 0, total: 0 });

export function totals(runs: FixtureRun[]): Totals {
  let header = zero();
  let lineFields = zero();
  let lineRecall = zero();
  let linePrecision = zero();
  let orders = zero();
  for (const r of runs) {
    header = add(header, r.score.header);
    lineFields = add(lineFields, r.score.lineFields);
    lineRecall = add(lineRecall, r.score.lineRecall);
    linePrecision = add(linePrecision, r.score.linePrecision);
    orders = add(orders, r.score.ordersFound);
  }
  const latencies = runs.map((r) => r.latencyMs).sort((a, b) => a - b);
  const cost = runs.reduce((c, r) => c + r.costUsd, 0);
  return {
    headerAccuracy: rate(header),
    lineFieldAccuracy: rate(lineFields),
    lineRecall: rate(lineRecall),
    linePrecision: rate(linePrecision),
    orderRecall: rate(orders),
    perfectDocs: runs.filter((r) => r.score.perfect).length / Math.max(runs.length, 1),
    fixtures: runs.length,
    costUsd: cost,
    costPerDoc: cost / Math.max(runs.length, 1),
    medianLatencyMs: latencies[Math.floor(latencies.length / 2)] ?? 0,
    // Matching arrives in M5; the fixtures already carry expectedSku for it.
    skuMatchAccuracy: null,
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const esc = (v: unknown) =>
  String(
    v === null || v === undefined ? '∅' : typeof v === 'object' ? JSON.stringify(v) : v,
  ).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

function fixtureSection(r: FixtureRun): string {
  const s = r.score;
  const status = r.error
    ? `<span class="bad">error: ${esc(r.error)}</span>`
    : r.extractions
        .map((x) => `${esc(x.source.label)} → ${x.status}${x.error ? ` (${esc(x.error)})` : ''}`)
        .join('; ');
  const orders = r.orders
    .map((o, i) => {
      const head = o.header
        .map(
          (f) =>
            `<tr class="${f.ok ? '' : 'miss'}"><td>${f.field}</td><td>${esc(f.expected)}</td><td>${esc(f.actual)}</td></tr>`,
        )
        .join('');
      const lines = o.lines
        .map((l) => {
          const wrong = l.fields.filter((f) => !f.ok);
          if (!l.actual)
            return `<tr class="miss"><td colspan="3">Missed line: ${esc(l.expected?.customerPartCode)} ${esc(l.expected?.description)} x${esc(l.expected?.quantity)}</td></tr>`;
          if (!l.expected)
            return `<tr class="miss"><td colspan="3">Extra line: ${esc(l.actual.customerPartCode)} ${esc(l.actual.description)} x${esc(l.actual.quantity)}</td></tr>`;
          return wrong
            .map(
              (f) =>
                `<tr class="miss"><td>line ${esc(l.expected?.customerPartCode ?? l.expected?.description)}: ${f.field}</td><td>${esc(f.expected)}</td><td>${esc(f.actual)}</td></tr>`,
            )
            .join('');
        })
        .join('');
      const title = o.expected
        ? `Order ${esc(o.expected.poNumber ?? i + 1)}`
        : 'Unexpected extra order';
      const missing = o.expected && !o.actual ? '<p class="bad">Not found</p>' : '';
      return `<h4>${title}</h4>${missing}<table><thead><tr><th>Field</th><th>Expected</th><th>Got</th></tr></thead><tbody>${head}${lines || ''}</tbody></table>`;
    })
    .join('');
  return `<details${s.perfect ? '' : ' open'}><summary><b>${esc(r.dir)}</b> ${s.perfect ? '<span class="good">perfect</span>' : ''} - header ${pct(rate(s.header))}, line fields ${pct(rate(s.lineFields))}, lines found ${pct(rate(s.lineRecall))} <span class="muted">(${r.latencyMs} ms, $${r.costUsd.toFixed(4)})</span></summary><p class="muted">${esc(r.fixture.description)}<br>${status}</p>${orders}</details>`;
}

export function htmlReport(
  provider: string,
  runs: FixtureRun[],
  t: Totals,
  generatedAt: Date,
): string {
  const card = (label: string, value: string) =>
    `<div class="card"><div class="label">${label}</div><div class="value">${value}</div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Keyless extraction eval</title>
<style>
:root{--bg:#f8fafc;--fg:#0f172a;--muted:#64748b;--card:#fff;--line:#e2e8f0;--bad:#b91c1c;--badbg:#fef2f2;--good:#047857}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--fg:#e2e8f0;--muted:#94a3b8;--card:#111827;--line:#1f2937;--bad:#f87171;--badbg:#2a1215;--good:#34d399}}
body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px 16px;max-width:1100px;margin-inline:auto}
h1{margin:0 0 4px}.muted{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:20px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.label{font-size:12px;color:var(--muted)}.value{font-size:22px;font-weight:600}
details{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:10px 0}summary{cursor:pointer}
table{border-collapse:collapse;width:100%;font-size:13px;margin:6px 0 12px}th,td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
tr.miss td{background:var(--badbg);color:var(--bad)}.bad{color:var(--bad)}.good{color:var(--good);font-weight:600}
</style></head><body>
<h1>Extraction eval</h1><p class="muted">Provider <b>${esc(provider)}</b> - ${t.fixtures} fixtures - ${generatedAt.toISOString()}</p>
<div class="cards">${card('Header fields', pct(t.headerAccuracy))}${card('Line fields', pct(t.lineFieldAccuracy))}${card('Lines found', pct(t.lineRecall))}${card('Lines correct (no extras)', pct(t.linePrecision))}${card('Orders found', pct(t.orderRecall))}${card('Perfect documents', pct(t.perfectDocs))}${card('Cost per document', `$${t.costPerDoc.toFixed(4)}`)}${card('Median latency', `${t.medianLatencyMs} ms`)}${card('SKU match', 'M5')}</div>
<p class="muted">Highlighted rows are mismatches. Null vs null is not counted; an invented value is counted as wrong.</p>
${runs.map(fixtureSection).join('\n')}
</body></html>`;
}
