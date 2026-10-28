import { extractPackSize } from '@keyless/shared';

/**
 * Key attributes agreement checker.
 *
 * Requirements (P0-2):
 * Key attributes that must agree when present in both texts:
 * - colour
 * - size (S/M/L/XL)
 * - material (nitrile/vinyl/latex/polythene)
 * - pack size
 * - volume (ml/L)
 *
 * A conflict on ANY of them counts as a mismatch even if overall similarity is high.
 */

export type AttributeConflict = {
  attribute: 'colour' | 'size' | 'material' | 'pack_size' | 'volume';
  customerValue: string;
  productValue: string;
};

const COLOURS = [
  'blue',
  'black',
  'white',
  'clear',
  'green',
  'red',
  'yellow',
  'pink',
  'purple',
  'orange',
  'grey',
  'gray',
];

function extractColours(text: string): Set<string> {
  const found = new Set<string>();
  const lower = text.toLowerCase();
  for (const c of COLOURS) {
    const reg = new RegExp(`\\b${c}\\b`, 'i');
    if (reg.test(lower)) {
      found.add(c === 'gray' ? 'grey' : c);
    }
  }
  return found;
}

const SIZE_MAP: Record<string, string> = {
  'extra small': 'XS',
  xs: 'XS',
  small: 'S',
  sml: 'S',
  s: 'S',
  medium: 'M',
  med: 'M',
  m: 'M',
  large: 'L',
  lg: 'L',
  l: 'L',
  'extra large': 'XL',
  xl: 'XL',
  xxl: 'XXL',
  '2xl': 'XXL',
};

function extractSizes(text: string): Set<string> {
  const found = new Set<string>();
  const lower = text.toLowerCase();

  // Multi-word first
  if (/\bextra\s+small\b/i.test(lower)) found.add('XS');
  if (/\bextra\s+large\b/i.test(lower)) found.add('XL');

  // Single tokens
  const tokens = lower.match(/\b(xs|small|sml|medium|med|large|lg|xl|xxl|2xl|[smlx])\b/gi) ?? [];
  for (const t of tokens) {
    const norm = SIZE_MAP[t.toLowerCase()];
    if (norm) found.add(norm);
  }
  return found;
}

const MATERIALS = ['nitrile', 'vinyl', 'latex', 'polythene', 'polyethylene'];

function extractMaterials(text: string): Set<string> {
  const found = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of MATERIALS) {
    const reg = new RegExp(`\\b${m}\\b`, 'i');
    if (reg.test(lower)) {
      found.add(m === 'polyethylene' ? 'polythene' : m);
    }
  }
  return found;
}

export function extractVolumeMl(text?: string | null): number | null {
  if (!text) return null;
  const match = text.match(/\b(\d+(?:\.\d+)?)\s*(ml|l|ltr|litre|litres)\b/i);
  if (!match || !match[1] || !match[2]) return null;
  const num = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (isNaN(num)) return null;
  if (unit.startsWith('l')) return Math.round(num * 1000);
  return Math.round(num);
}

export function findAttributeConflicts(
  customerDesc?: string | null,
  productDesc?: string | null,
): AttributeConflict[] {
  if (!customerDesc || !productDesc) return [];

  const conflicts: AttributeConflict[] = [];

  // 1. Material
  const custMats = extractMaterials(customerDesc);
  const prodMats = extractMaterials(productDesc);
  if (custMats.size > 0 && prodMats.size > 0) {
    const hasOverlap = [...custMats].some((m) => prodMats.has(m));
    if (!hasOverlap) {
      conflicts.push({
        attribute: 'material',
        customerValue: [...custMats].join(', '),
        productValue: [...prodMats].join(', '),
      });
    }
  }

  // 2. Colour
  const custColours = extractColours(customerDesc);
  const prodColours = extractColours(productDesc);
  if (custColours.size > 0 && prodColours.size > 0) {
    const hasOverlap = [...custColours].some((c) => prodColours.has(c));
    if (!hasOverlap) {
      conflicts.push({
        attribute: 'colour',
        customerValue: [...custColours].join(', '),
        productValue: [...prodColours].join(', '),
      });
    }
  }

  // 3. Size
  const custSizes = extractSizes(customerDesc);
  const prodSizes = extractSizes(productDesc);
  if (custSizes.size > 0 && prodSizes.size > 0) {
    const hasOverlap = [...custSizes].some((s) => prodSizes.has(s));
    if (!hasOverlap) {
      conflicts.push({
        attribute: 'size',
        customerValue: [...custSizes].join(', '),
        productValue: [...prodSizes].join(', '),
      });
    }
  }

  // 4. Pack size
  const custPack = extractPackSize(customerDesc);
  const prodPack = extractPackSize(productDesc);
  if (custPack !== null && prodPack !== null && custPack !== prodPack) {
    conflicts.push({
      attribute: 'pack_size',
      customerValue: String(custPack),
      productValue: String(prodPack),
    });
  }

  // 5. Volume
  const custVol = extractVolumeMl(customerDesc);
  const prodVol = extractVolumeMl(productDesc);
  if (custVol !== null && prodVol !== null && custVol !== prodVol) {
    conflicts.push({
      attribute: 'volume',
      customerValue: `${custVol}ml`,
      productValue: `${prodVol}ml`,
    });
  }

  return conflicts;
}
