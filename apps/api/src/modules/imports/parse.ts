import Papa from 'papaparse';
import type { ImportFieldType } from '@keyless/shared';

/**
 * Decode an uploaded file. UK exports from older ERPs/Excel are often Windows-1252 (the £ sign
 * breaks as UTF-8), so fall back to that when the bytes are not valid UTF-8.
 */
export function decodeCsv(buffer: Buffer): { text: string; encoding: string } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { text: stripBom(text), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(buffer), encoding: 'windows-1252' };
  }
}

export type ParsedCsv = { columns: string[]; rows: Record<string, string>[] };

export function parseCsv(text: string): ParsedCsv {
  const seen = new Map<string, number>();
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    // Blank or duplicate headers still need distinct, stable names for mapping.
    transformHeader: (h, i) => {
      const base = h.trim() || `Column ${i + 1}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return n ? `${base} (${n + 1})` : base;
    },
    transform: (v) => v.trim(),
  });
  const columns = result.meta.fields ?? [];
  if (!columns.length) throw new Error('The file has no header row');
  return { columns, rows: result.data };
}

export type Coerced = { ok: true; value: unknown } | { ok: false; message: string };

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'active', 'enabled', 'on', 'x']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'inactive', 'disabled', 'off']);

/** Convert a raw cell to the field's type. Empty cells return `undefined` (left unchanged). */
export function coerce(type: ImportFieldType, raw: string | undefined): Coerced {
  const value = (raw ?? '').trim();
  if (!value) return { ok: true, value: undefined };

  switch (type) {
    case 'string':
      return { ok: true, value };
    case 'number': {
      // "£1,234.50", "1 234,50" is not supported (UK first): commas are thousands separators.
      const cleaned = value.replace(/[£$€,\s]/g, '');
      const n = Number(cleaned);
      return Number.isFinite(n) && cleaned !== ''
        ? { ok: true, value: n }
        : { ok: false, message: `"${value}" is not a number` };
    }
    case 'boolean': {
      const lower = value.toLowerCase();
      if (TRUE_WORDS.has(lower)) return { ok: true, value: true };
      if (FALSE_WORDS.has(lower)) return { ok: true, value: false };
      return { ok: false, message: `"${value}" is not yes/no` };
    }
    case 'date': {
      const d = parseDate(value);
      return d
        ? { ok: true, value: d }
        : { ok: false, message: `"${value}" is not a date (use YYYY-MM-DD or DD/MM/YYYY)` };
    }
    case 'list':
      return {
        ok: true,
        value: value
          .split(/[;,|\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
  }
}

/** ISO dates, or UK day-first dates (DD/MM/YYYY, DD-MM-YY, DD.MM.YYYY). */
export function parseDate(value: string): Date | null {
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value);
  const uk = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(value);
  if (iso) {
    [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (uk) {
    [d, m, y] = [Number(uk[1]), Number(uk[2]), Number(uk[3])];
    if (y < 100) y += 2000;
  } else {
    return null;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? date
    : null;
}

/** Drop a leading UTF-8 byte-order mark (Excel's "CSV UTF-8" adds one). */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
