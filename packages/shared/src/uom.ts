/**
 * Unit of Measure (UOM) and Pack-Size conversion helpers.
 *
 * Guiding principle: a wrong order reaching the ERP (wrong product, wrong quantity)
 * is far worse than an order needing human review.
 *
 * ourQty = customerQty * factor
 * factor = how many of OUR selling units one CUSTOMER unit equals.
 */

export const UOM_SYNONYMS: Record<string, string[]> = {
  BOX: ['box', 'bx', 'boxes', 'bxs', 'bx.'],
  CASE: ['case', 'cs', 'ctn', 'carton', 'cases', 'cartons', 'cs.'],
  EACH: [
    'each',
    'ea',
    'pc',
    'pcs',
    'piece',
    'pieces',
    'unit',
    'units',
    'single',
    'singles',
    'item',
    'items',
    'no',
    'ea.',
  ],
  PACK: ['pack', 'pk', 'pck', 'packs', 'pks', 'packet', 'packets', 'pkg', 'pkgs'],
  TUB: ['tub', 'tubs'],
  BOTTLE: ['bottle', 'btl', 'bottles', 'btls'],
  ROLL: ['roll', 'rl', 'rolls'],
  PAIR: ['pair', 'pr', 'pairs'],
  BAG: ['bag', 'bg', 'bags'],
  TIN: ['tin', 'tins', 'can', 'cans'],
};

export function normalizeUom(unit?: string | null): string | null {
  if (!unit) return null;
  const clean = unit.trim().toLowerCase();
  for (const [canonical, syns] of Object.entries(UOM_SYNONYMS)) {
    if (syns.includes(clean) || canonical.toLowerCase() === clean) {
      return canonical;
    }
  }
  return clean.toUpperCase();
}

export function areUomEqual(uomA?: string | null, uomB?: string | null): boolean {
  if (!uomA || !uomB) return false;
  const a = normalizeUom(uomA);
  const b = normalizeUom(uomB);
  return Boolean(a && b && a === b);
}

export function isEachUnit(unit?: string | null): boolean {
  if (!unit) return false;
  return normalizeUom(unit) === 'EACH';
}

export function isPackUnit(unit?: string | null): boolean {
  if (!unit) return false;
  const norm = normalizeUom(unit);
  return norm === 'BOX' || norm === 'CASE' || norm === 'PACK';
}

/**
 * Extract numeric pack size from a description string, e.g.:
 * "(Box 100)" -> 100
 * "(Case 2)" -> 2
 * "Box of 100" -> 100
 * "100pk" -> 100
 */
export function extractPackSize(text?: string | null): number | null {
  if (!text) return null;

  // Patterns like (Box 100), (Case 2), (100), [Box 100], (Pack 50), (Carton 24)
  const bracketMatch = text.match(
    /[([{\\/]\s*(?:box|case|carton|pack|pk|ctn|cs)?\s*(\d+)\s*(?:count|ct|pcs|pk|pack|box|case)?\s*[)\]}\\/]/i,
  );
  if (bracketMatch && bracketMatch[1]) {
    const val = parseInt(bracketMatch[1], 10);
    if (!isNaN(val) && val > 0) return val;
  }

  // Patterns like "Box of 100", "Pack of 50", "Case of 12"
  const ofMatch = text.match(/\b(?:box|case|carton|pack|pk)\s+of\s+(\d+)\b/i);
  if (ofMatch && ofMatch[1]) {
    const val = parseInt(ofMatch[1], 10);
    if (!isNaN(val) && val > 0) return val;
  }

  // Patterns like "100pk", "100 pack", "100 pcs"
  const pkMatch = text.match(/\b(\d+)\s*(?:pk|pack|pcs|count|ct)\b/i);
  if (pkMatch && pkMatch[1]) {
    const val = parseInt(pkMatch[1], 10);
    if (!isNaN(val) && val > 0) return val;
  }

  return null;
}

export type UomConversionResult = {
  factor: number;
  convertedQuantity: number | null;
  warning?: string;
  blockingError?: string;
};

/**
 * Computes UOM conversion factor and converted quantity:
 * ourQty = customerQty * factor
 */
export function computeUomConversion(input: {
  customerQty: number | null | undefined;
  customerUnit?: string | null;
  customerDescription?: string | null;
  productUom?: string | null;
  productPackSize?: number | null;
  productDescription?: string | null;
  isExistingXref?: boolean;
  xrefFactor?: number | null;
}): UomConversionResult {
  const {
    customerQty,
    customerUnit,
    customerDescription,
    productUom,
    productPackSize,
    productDescription,
    isExistingXref,
    xrefFactor,
  } = input;

  // If there's an existing confirmed CrossReference factor, respect it
  if (isExistingXref && xrefFactor !== undefined && xrefFactor !== null && xrefFactor > 0) {
    const converted =
      customerQty !== null && customerQty !== undefined
        ? Math.round(customerQty * xrefFactor * 10_000) / 10_000
        : null;
    return {
      factor: xrefFactor,
      convertedQuantity: converted,
    };
  }

  const packSize = productPackSize && productPackSize > 1 ? productPackSize : 1;
  const custDescPackSize = extractPackSize(customerDescription);
  const prodDescPackSize = extractPackSize(productDescription);

  let factor = 1;

  // Rule 1: Customer's unit matches our unit of measure (with synonyms: box/bx, case/cs, each/ea, etc.)
  if (areUomEqual(customerUnit, productUom)) {
    factor = 1;
  }
  // Rule 2: Both descriptions specify the same pack size (e.g. both "(Box 100)")
  else if (
    custDescPackSize !== null &&
    prodDescPackSize !== null &&
    custDescPackSize === prodDescPackSize
  ) {
    factor = 1;
  }
  // Rule 3: Customer unit is null/unknown: DEFAULT factor = 1, do NOT multiply by pack size
  else if (!customerUnit || customerUnit.trim() === '') {
    // Default factor = 1 and do not multiply by pack size.
    factor = 1;
  }
  // Rule 4: Customer ordered "boxes/cases/packs", our product is sold in "each"
  else if (isPackUnit(customerUnit) && isEachUnit(productUom) && packSize > 1) {
    factor = packSize;
  }
  // Rule 5: Customer ordered "each/pcs", our product is sold in "box/case/pack"
  else if (isEachUnit(customerUnit) && !isEachUnit(productUom) && packSize > 1) {
    factor = 1 / packSize;
  }
  // Otherwise, default factor is 1
  else {
    factor = 1;
  }

  const convertedQuantity =
    customerQty !== null && customerQty !== undefined
      ? Math.round(customerQty * factor * 10_000) / 10_000
      : null;

  let warning: string | undefined;
  let blockingError: string | undefined;

  if (factor !== 1) {
    const custUnitLabel = customerUnit ? customerUnit.trim() : 'customer units';
    const ourUnitLabel = productUom ? productUom.trim().toLowerCase() : 'our units';
    warning = `Quantity converted from ${customerQty ?? ''} ${custUnitLabel} to ${convertedQuantity ?? ''} ${ourUnitLabel} — please confirm`;

    if (convertedQuantity !== null && !Number.isInteger(convertedQuantity)) {
      blockingError = `${customerQty} ${custUnitLabel} is ${convertedQuantity} ${ourUnitLabel} (pack of ${packSize}): not a whole pack`;
    }
  }

  return {
    factor,
    convertedQuantity,
    warning,
    blockingError,
  };
}
