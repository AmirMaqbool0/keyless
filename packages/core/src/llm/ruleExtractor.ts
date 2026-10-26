import type { ExtractedLine, ExtractedOrder, ExtractionOutput } from '@keyless/shared';

/**
 * A deterministic, offline purchase-order reader for text-layer PDFs, spreadsheets, CSVs and
 * email bodies. It powers the mock LLM provider so the whole pipeline (and the eval harness) runs
 * with no API key, and it is a useful baseline to measure the real LLM against. It cannot read
 * scanned documents or photos.
 */

type Ctx = {
  fromName?: string;
  fromAddress?: string;
  isBody: boolean;
  /** The email subject: POs are often only named there ("Order PO-123" + a spreadsheet). */
  subject?: string;
  /** The email body, for the sender's company name in the signature. */
  emailText?: string;
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE_RE = String.raw`(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})`;
const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
const UNIT_WORDS =
  'boxes|box|cases|case|packs|pack|each|ea|rolls|roll|bottles|bottle|bags|bag|cartons|carton|tubs|tub|units|unit|pcs|pieces|sleeves|sleeve|tins|tin|drums|drum';
const pad = (n: number) => String(n).padStart(2, '0');

export function parseDocDate(raw: string): string | null {
  const s = raw
    .trim()
    .replace(/(\d)(st|nd|rd|th)\b/i, '$1')
    .replace(/,/g, '');
  let y: number, m: number, d: number;
  let match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)))
    [y, m, d] = [+match[1]!, +match[2]!, +match[3]!];
  else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s)))
    [d, m, y] = [+match[1]!, +match[2]!, +match[3]!];
  else if ((match = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(s)))
    [d, m, y] = [+match[1]!, MONTHS.indexOf(match[2]!.slice(0, 3).toLowerCase()) + 1, +match[3]!];
  else if ((match = /^([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{4})$/.exec(s)))
    [m, d, y] = [MONTHS.indexOf(match[1]!.slice(0, 3).toLowerCase()) + 1, +match[2]!, +match[3]!];
  else return null;
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (!m || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function parseAmount(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[£$€,\s]|GBP|EUR|USD/gi, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

function cells(line: string): string[] {
  if (line.includes(' | ')) return line.split('|').map((c) => c.trim());
  if (line.includes('\t')) return line.split('\t').map((c) => c.trim());
  return line.split(/\s{3,}/).map((c) => c.trim());
}

type Column = 'code' | 'description' | 'qty' | 'unit' | 'price' | 'total' | 'po';
const HEADER_WORDS: [Column, RegExp][] = [
  ['po', /^(po|p\.o\.?|po\s*(no|number|#)|order\s*(no|number|ref))$/i],
  [
    'code',
    /^(item\s*(code|no\.?|#)?|code|sku|part\s*(no\.?|number|code)?|product\s*code|your\s*(ref|code|part\s*no\.?)|stock\s*code|ref(erence)?|cat(alogue)?\s*no\.?|article)$/i,
  ],
  [
    'description',
    /^(description|desc\.?|item\s*description|product(\s*name)?|details|goods|item\s*name|name)$/i,
  ],
  [
    'qty',
    /^(qty|quantity|qty\s*ordered|order\s*qty|units\s*ordered|no\.?\s*of\s*units|amount\s*ordered)$/i,
  ],
  ['unit', /^(unit|uom|units|pack|pack\s*size|unit\s*of\s*measure)$/i],
  ['price', /^(unit\s*price|price|rate|cost|unit\s*cost|price\s*each|each|net\s*price)$/i],
  ['total', /^(total|line\s*total|amount|value|net|net\s*total|ext\.?\s*price|extended)$/i],
];

/** Header words cut off by a narrow column ("Quantit" / "y") still count by prefix. */
const HEADER_PREFIXES: [Column, string[]][] = [
  ['qty', ['quantity']],
  ['description', ['description', 'item description']],
  ['price', ['unit price', 'price each']],
  ['code', ['item code', 'product code', 'stock code', 'your ref', 'reference']],
];

function headerMap(row: string[]): Partial<Record<Column, number>> | null {
  const map: Partial<Record<Column, number>> = {};
  row.forEach((cell, i) => {
    const text = cell.replace(/[£():]/g, '').trim();
    for (const [col, re] of HEADER_WORDS) {
      if (map[col] === undefined && re.test(text)) {
        map[col] = i;
        return;
      }
    }
    const lower = text.toLowerCase();
    if (lower.length < 4) return;
    for (const [col, words] of HEADER_PREFIXES) {
      if (map[col] === undefined && words.some((w) => w.startsWith(lower))) {
        map[col] = i;
        return;
      }
    }
  });
  const found = Object.keys(map).length;
  return map.qty !== undefined &&
    (map.code !== undefined || map.description !== undefined) &&
    found >= 2
    ? map
    : null;
}

const lineConfidence = (v: number) => ({
  customerPartCode: v,
  description: v,
  quantity: v,
  unitPrice: v,
});

/** Rows of the first item table in the text, or null if there is none. */
function tableLines(
  lines: string[],
): { items: ExtractedLine[]; po: (string | null)[]; endIndex: number } | null {
  for (let h = 0; h < lines.length; h++) {
    const map = headerMap(cells(lines[h]!));
    if (!map) continue;
    const items: ExtractedLine[] = [];
    const po: (string | null)[] = [];
    // After a page break, everything up to the repeated table header is page furniture.
    let betweenPages = false;
    let i = h + 1;
    for (; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) {
        const next = lines.slice(i + 1).find((l) => l.trim());
        if (items.length && !(next && /^---\s*(Page|Sheet)/.test(next))) break;
        continue;
      }
      if (/^---\s*(Page|Sheet)/.test(line)) {
        betweenPages = true;
        continue;
      }
      // Repeated header on a new page.
      if (headerMap(cells(line))) {
        betweenPages = false;
        continue;
      }
      const row = cells(line);
      const qty = map.qty !== undefined ? parseAmount(row[map.qty]) : null;
      if (qty !== null) betweenPages = false;
      if (qty === null) {
        if (betweenPages || /\bcontinued\b|\bpage\s+\d/i.test(line)) continue;
        // A wrapped description continues the previous line; anything else ends the table.
        if (
          items.length &&
          row.length === 1 &&
          !/total|vat|tax|subtotal|carriage|delivery|please|thank/i.test(line) &&
          !/:/.test(line)
        ) {
          const last = items[items.length - 1]!;
          last.description = `${last.description ?? ''} ${line.trim()}`.trim();
          continue;
        }
        if (/total|vat|tax/i.test(line)) break;
        continue;
      }
      const get = (c: Column) => (map[c] !== undefined ? row[map[c]!]?.trim() || null : null);
      items.push({
        lineNo: items.length + 1,
        customerPartCode: get('code'),
        description: get('description'),
        quantity: qty,
        unit: get('unit'),
        unitPrice: parseAmount(get('price')),
        lineTotal: parseAmount(get('total')),
        confidence: lineConfidence(0.75),
      });
      po.push(get('po'));
    }
    return items.length ? { items, po, endIndex: i } : null;
  }
  return null;
}

/** Item lines written in an email body: "10 x GL1001 Gloves", "GL1001 - Gloves - 10", "5 boxes of gloves". */
function bodyLines(lines: string[]): ExtractedLine[] {
  const items: ExtractedLine[] = [];
  const add = (l: Omit<ExtractedLine, 'lineNo' | 'confidence'>, conf: number) =>
    items.push({ lineNo: items.length + 1, ...l, confidence: lineConfidence(conf) });
  const qtyCode = new RegExp(
    String.raw`^\s*[-*•]?\s*(\d+(?:\.\d+)?)\s*(?:x|\*|×)\s*([A-Z]{1,6}[-/.]?\d[\w\-/.]*)\s+(.+?)\s*$`,
    'i',
  );
  const qtyUnitOf = new RegExp(
    String.raw`^\s*[-*•]?\s*(\d+(?:\.\d+)?)\s*(${UNIT_WORDS})\s*(?:of\s+)?(.+?)\s*$`,
    'i',
  );
  const codeDescQty =
    /^\s*[-*•]?\s*([A-Z]{1,6}[-/.]?\d[\w\-/.]*)\s*[-:–]\s*(.+?)\s*[-:–,]\s*(?:qty:?\s*)?(\d+(?:\.\d+)?)\s*(\w+)?\s*$/i;
  for (const raw of lines) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = qtyCode.exec(line)))
      add(
        {
          customerPartCode: m[2]!,
          description: m[3]!,
          quantity: +m[1]!,
          unit: null,
          unitPrice: null,
          lineTotal: null,
        },
        0.65,
      );
    else if ((m = codeDescQty.exec(line)))
      add(
        {
          customerPartCode: m[1]!,
          description: m[2]!,
          quantity: +m[3]!,
          unit: m[4] ?? null,
          unitPrice: null,
          lineTotal: null,
        },
        0.6,
      );
    else if (
      (m = qtyUnitOf.exec(line)) &&
      !/\b(street|road|lane|avenue|way|close|st\.?|rd\.?)\b/i.test(line)
    ) {
      add(
        {
          customerPartCode: null,
          description: m[3]!,
          quantity: +m[1]!,
          unit: m[2]!.toLowerCase(),
          unitPrice: null,
          lineTotal: null,
        },
        0.5,
      );
    }
  }
  if (items.length) return items;

  // Free text: "Can we get 5 boxes of medium blue gloves and 2 cases of bleach please"
  const sentence = lines.join(' ');
  // Descriptions may hold quotes, dots and sizes (11x17x18", 0.5L), so stop only at separators.
  const re = new RegExp(
    String.raw`(\d+(?:\.\d+)?)\s+(${UNIT_WORDS})\s+of\s+([a-z0-9][^,?!]*?)(?=\s*(?:,|\band\b|\bplease\b|\?|!|\.\s|\.$|$))`,
    'gi',
  );
  for (const m of sentence.matchAll(re)) {
    add(
      {
        customerPartCode: null,
        description: m[3]!.trim(),
        quantity: +m[1]!,
        unit: m[2]!.toLowerCase(),
        unitPrice: null,
        lineTotal: null,
      },
      0.45,
    );
  }
  return items;
}

function findLabelled(text: string, label: RegExp): string | null {
  const m = label.exec(text);
  return m?.[1]?.trim() ?? null;
}

const PO_VALUE = String.raw`([A-Z0-9][\w\-/]*\d[\w\-/]*)`;
const PO_PATTERNS = [
  // "PO Number: PO-4471", "Order No. 4471", "Purchase order ref: AB/123"
  new RegExp(
    String.raw`\b(?:p\.?\s?o\.?|purchase\s+order|order)\s*(?:number|no\.?|num|#|ref(?:erence)?)\s*[:#.]?\s*${PO_VALUE}`,
    'i',
  ),
  // A bare token: "PO-4471", "PO4471"
  /\b(P\.?O[-/]?\d[\w\-/]*)/i,
  // "Purchase Order 4471"
  new RegExp(String.raw`\bpurchase\s+order\s*[:#]?\s*${PO_VALUE}`, 'i'),
];

function poNumber(text: string): string | null {
  for (const re of PO_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1] && m[1].length >= 3) return m[1].replace(/[.,;:]+$/, '');
  }
  return null;
}

function address(lines: string[]): ExtractedOrder['deliveryAddress'] {
  const empty = { line1: null, line2: null, city: null, postcode: null, country: null };
  const i = lines.findIndex((l) =>
    /^\s*(deliver(y)?\s*(to|address)|ship\s*to|delivery\s*point)\b/i.test(l),
  );
  if (i === -1) return empty;
  const after = lines[i]!.replace(/^\s*[^:]*:\s*/, '').trim();
  const block: string[] = after && after !== lines[i]!.trim() ? [after] : [];
  for (let j = i + 1; j < lines.length && block.length < 6; j++) {
    const l = lines[j]!.trim();
    if (!l || l.includes('|') || /:\s*\S/.test(l) || /^(item|code|qty|description)\b/i.test(l))
      break;
    block.push(l.replace(/,$/, ''));
  }
  if (block.length === 1 && block[0]!.includes(','))
    block.splice(0, 1, ...block[0]!.split(',').map((s) => s.trim()));
  const pcIndex = block.findIndex((l) => UK_POSTCODE.test(l));
  const pcMatch = pcIndex >= 0 ? UK_POSTCODE.exec(block[pcIndex]!) : null;
  const postcode = pcMatch ? `${pcMatch[1]!.toUpperCase()} ${pcMatch[2]!.toUpperCase()}` : null;
  const rest = block.filter((_, k) => k !== pcIndex);
  const sameLineCity =
    pcIndex >= 0
      ? block[pcIndex]!.replace(UK_POSTCODE, '')
          .replace(/[,\s]+$/, '')
          .trim()
      : '';
  const city = sameLineCity || (rest.length > 1 ? rest[rest.length - 1]! : null);
  const streetLines = sameLineCity ? rest : rest.slice(0, rest.length > 1 ? -1 : undefined);
  return {
    line1: streetLines[0] ?? null,
    line2: streetLines.slice(1).join(', ') || null,
    city,
    postcode,
    country: block.some((l) => /united kingdom|^uk$|england|scotland|wales/i.test(l)) ? 'GB' : null,
  };
}

/** Company line of an email signature: "Kind regards, / Name / Company". */
function signatureCompany(lines: string[]): string | null {
  const k = lines.findIndex((l) =>
    /^(kind\s+)?(regards|thanks|thank you|many thanks|cheers|best)\b/i.test(l.trim()),
  );
  const sig =
    k >= 0
      ? lines
          .slice(k + 1)
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
  return sig[1] ?? null;
}

function customerName(lines: string[], ctx: Ctx): string | null {
  if (ctx.isBody) return signatureCompany(lines);
  // A document's letterhead: the first cell of its first meaningful line.
  for (const raw of lines) {
    const first = cells(raw)[0]?.trim() ?? '';
    if (!first || /^---/.test(first)) continue;
    if (
      headerMap(cells(raw)) ||
      /purchase\s+order|^order\b|^page\b|:/i.test(first) ||
      /\d{3,}/.test(first)
    )
      break;
    return first;
  }
  return ctx.emailText ? signatureCompany(ctx.emailText.split('\n')) : null;
}

function orderFromSection(
  text: string,
  ctx: Ctx,
  table: { items: ExtractedLine[] } | null,
): ExtractedOrder {
  const lines = text.split('\n');
  const items = table?.items ?? bodyLines(lines);
  const po = poNumber(text) ?? (ctx.subject ? poNumber(ctx.subject) : null);
  const orderDate = findLabelled(
    text,
    new RegExp(String.raw`(?:order\s+date|po\s+date|^\s*date)\s*[:\-]?\s*${DATE_RE}`, 'im'),
  );
  const deliveryDate = findLabelled(
    text,
    new RegExp(
      String.raw`(?:deliver(?:y)?\s*(?:date|by|on|required)|required\s*(?:by|on|date)|due\s*date|need(?:ed)?\s*(?:by|on))\s*[:\-]?\s*${DATE_RE}`,
      'i',
    ),
  );
  const totals = {
    subtotal: parseAmount(
      findLabelled(text, /sub[\s-]?total\s*(?:\(.*?\))?\s*[:-]?\s*([£$€]?\s*[\d,]+\.\d{2})/i),
    ),
    tax: parseAmount(
      findLabelled(
        text,
        /\b(?:vat|tax)\b[^\n\d£$€]*(?:\d{1,2}(?:\.\d+)?%)?[^\n\d£$€]*([£$€]?\s*[\d,]+\.\d{2})/i,
      ),
    ),
    total: parseAmount(
      findLabelled(
        text,
        /(?<!sub[\s-]?)\b(?:grand\s+|order\s+)?total(?:\s+(?:due|inc\.?\s*vat|gbp))?\s*[:-]?\s*([£$€]\s*[\d,]+\.\d{2}|[\d,]+\.\d{2}\s*$)/im,
      ),
    ),
  };
  // A subtotal-only document: "Total" alone after "Subtotal" can be the same figure; keep only a distinct grand total.
  if (
    totals.total !== null &&
    totals.subtotal !== null &&
    totals.tax === null &&
    totals.total === totals.subtotal
  )
    totals.total = null;
  const account = findLabelled(
    text,
    /(?:account|a\/c|acc(?:ount)?\.?\s*(?:no|number|code)|customer\s*(?:no|number|code|ref))\s*[:#.]?\s*([A-Z0-9][A-Z0-9-]{2,})/i,
  );
  const notes = findLabelled(
    text,
    /(?:delivery\s+(?:notes?|instructions?)|notes?|instructions?)\s*:\s*(.+)/i,
  );
  const currency = /£|\bGBP\b/.test(text)
    ? 'GBP'
    : /€|\bEUR\b/.test(text)
      ? 'EUR'
      : /\$|\bUSD\b/.test(text)
        ? 'USD'
        : null;
  return {
    customer: {
      name: customerName(lines, ctx),
      accountNumber: account,
      email: ctx.fromAddress ?? null,
    },
    poNumber: po,
    orderDate: orderDate ? parseDocDate(orderDate) : null,
    requestedDeliveryDate: deliveryDate ? parseDocDate(deliveryDate) : null,
    deliveryAddress: address(lines),
    notes,
    currency,
    lines: items,
    documentTotals: totals,
    fieldConfidence: {
      customer: 0.5,
      poNumber: po ? 0.8 : 0.3,
      orderDate: orderDate ? 0.75 : 0.3,
      deliveryAddress: 0.6,
    },
  };
}

/** Split a multi-order document: pages (or sheets) are grouped by the PO number they show. */
function sections(text: string): string[] {
  const pages = text.split(/(?=^--- (?:Page|Sheet)[^\n]*---$)/m).filter((p) => p.trim());
  if (pages.length <= 1) return [text];
  const groups: { po: string | null; text: string }[] = [];
  for (const page of pages) {
    const po = poNumber(page);
    const last = groups[groups.length - 1];
    if (last && (!po || po === last.po)) last.text += `\n${page}`;
    else groups.push({ po, text: page });
  }
  return groups.map((g) => g.text);
}

export function ruleExtract(text: string, ctx: Ctx): ExtractionOutput {
  const orders: ExtractedOrder[] = [];
  for (const section of sections(text)) {
    const lines = section.split('\n');
    const table = tableLines(lines);
    // One spreadsheet holding several POs: a PO column splits it into several orders.
    if (table && table.po.some(Boolean) && new Set(table.po.filter(Boolean)).size > 1) {
      for (const po of new Set(table.po.filter(Boolean) as string[])) {
        const items = table.items
          .filter((_, i) => table.po[i] === po)
          .map((l, i) => ({ ...l, lineNo: i + 1 }));
        const order = orderFromSection(section, ctx, { items });
        orders.push({
          ...order,
          poNumber: po,
          documentTotals: { subtotal: null, tax: null, total: null },
        });
      }
      continue;
    }
    const order = orderFromSection(section, ctx, table);
    if (table && !order.poNumber && table.po[0]) order.poNumber = table.po[0];
    if (order.lines.length || (order.poNumber && !ctx.isBody)) orders.push(order);
  }
  return {
    orders,
    documentNotes: orders.length
      ? 'Read by the offline rule-based extractor.'
      : 'No order found by the offline rule-based extractor.',
  };
}

/** Number of data rows in the first item table, for the line-count check. Null if no table. */
export function countTableRows(text: string): number | null {
  return tableLines(text.split('\n'))?.items.length ?? null;
}
