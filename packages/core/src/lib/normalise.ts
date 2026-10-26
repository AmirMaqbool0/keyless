/**
 * Normalised keys used for uniqueness and matching. Raw values are always kept alongside for
 * display; only these keys are indexed.
 */

/** Our own SKUs: case-insensitive, whitespace collapsed. "ab 123 " -> "AB 123". */
export function skuKey(sku: string): string {
  return sku.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Account codes: same rules as SKUs. */
export const accountKey = skuKey;

/**
 * Customer part codes are typed inconsistently on POs ("AB-123", "ab 123", "AB.123"), so we
 * drop separators entirely. "ab-12.3 x" -> "AB123X".
 */
export function partCodeKey(code: string): string {
  return code.toUpperCase().replace(/[\s\-._/\\]+/g, '');
}

/** Free-text descriptions: lower-case alphanumeric tokens. "Gloves, Nitrile (Blue) M" -> "gloves nitrile blue m". */
export function descriptionKey(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Lower-cased haystack for substring search. */
export function searchText(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Mongo filter matching every whitespace-separated token as a substring of `field`. */
export function tokenFilter(field: string, q: string | undefined): Record<string, unknown> {
  const tokens = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!tokens.length) return {};
  return { [field]: { $all: tokens.map((t) => new RegExp(escapeRegex(t))) } };
}
