import { describe, expect, it } from 'vitest';
import { suggestMapping } from '@keyless/shared';
import { descriptionKey, partCodeKey, skuKey } from '../src/lib/normalise';
import { coerce, decodeCsv, parseCsv, parseDate } from '../src/modules/imports/parse';

describe('CSV parsing', () => {
  it('decodes Windows-1252 exports (the £ sign) and strips a UTF-8 BOM', () => {
    const cp1252 = Buffer.from([0x50, 0x72, 0x69, 0x63, 0x65, 0x0a, 0xa3, 0x35]); // "Price\n£5"
    expect(decodeCsv(cp1252)).toEqual({ text: 'Price\n£5', encoding: 'windows-1252' });
    expect(decodeCsv(Buffer.from('﻿a,b')).text).toBe('a,b');
  });

  it('names blank and duplicate headers and trims cells', () => {
    const { columns, rows } = parseCsv('Code,,Code\n A1 , x ,B2\n\n');
    expect(columns).toEqual(['Code', 'Column 2', 'Code (2)']);
    expect(rows).toEqual([{ Code: 'A1', 'Column 2': 'x', 'Code (2)': 'B2' }]);
  });

  it('auto-maps typical ERP headers', () => {
    const mapping = suggestMapping('products', [
      'Stock Code',
      'Description',
      'Pack Qty',
      'EAN',
      'Sell Price',
      'Something',
    ]);
    expect(mapping).toMatchObject({
      sku: 'Stock Code',
      description: 'Description',
      packSize: 'Pack Qty',
      barcode: 'EAN',
      defaultPrice: 'Sell Price',
      uom: null,
    });
  });
});

describe('value coercion', () => {
  it('parses UK-formatted numbers, booleans, lists and dates', () => {
    expect(coerce('number', '£1,234.50')).toEqual({ ok: true, value: 1234.5 });
    expect(coerce('number', 'abc').ok).toBe(false);
    expect(coerce('number', '')).toEqual({ ok: true, value: undefined });
    expect(coerce('boolean', 'Y')).toEqual({ ok: true, value: true });
    expect(coerce('boolean', 'Inactive')).toEqual({ ok: true, value: false });
    expect(coerce('boolean', 'maybe').ok).toBe(false);
    expect(coerce('list', 'a@x.com; b@x.com,c@x.com')).toEqual({
      ok: true,
      value: ['a@x.com', 'b@x.com', 'c@x.com'],
    });
    expect(parseDate('31/01/2026')?.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseDate('01/02/26')?.toISOString().slice(0, 10)).toBe('2026-02-01');
  });
});

describe('normalised keys', () => {
  it('makes codes and descriptions comparable', () => {
    expect(skuKey(' ab  12 ')).toBe('AB 12');
    expect(partCodeKey('ab-12.3 x')).toBe('AB123X');
    expect(descriptionKey('Gloves, Nitrile (Blue) M')).toBe('gloves nitrile blue m');
  });
});
