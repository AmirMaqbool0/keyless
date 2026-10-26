import type { ExtractedOrderDto, IssueSeverity, MatchMethod, RouteColour } from '@keyless/shared';
import type { CatalogueIndex } from './catalogue';
import { matchLine, type CustomerMatch } from './match';
import { routeOrder, type RoutingSettings } from './route';

/*
 * Turns one extracted purchase order into a routed order draft: matched lines, unit conversion,
 * expected prices, the validation issues of spec section 8, and a green/amber/red result.
 * Pure (no database): duplicates are looked up by the caller and passed in.
 */

export type IssueDraft = {
  code: string;
  severity: IssueSeverity;
  blocking: boolean;
  message: string;
  lineNo?: number;
};

export type LineDraft = {
  lineNo: number;
  customerPartCode?: string;
  description?: string;
  quantity?: number;
  unit?: string;
  unitPrice?: number;
  lineTotal?: number;
  productId?: string;
  sku?: string;
  productDescription?: string;
  matchMethod: MatchMethod;
  matchConfidence: number;
  candidates: { productId: string; sku: string; description: string; score: number }[];
  convertedQuantity?: number;
  uom?: string;
  conversionFactor: number;
  expectedPrice?: number;
  priceSource?: 'contract' | 'price_list' | 'default';
  stockQty?: number;
  colour: RouteColour;
  extractionConfidence: number;
  edited: boolean;
};

export type OrderDraft = {
  lines: LineDraft[];
  issues: IssueDraft[];
  value?: number;
  colour: RouteColour;
  status: ReturnType<typeof routeOrder>['status'];
  confidence: number;
};

const money = (n: number) => `£${n.toFixed(2)}`;
const undef = <T>(v: T | null | undefined) => (v === null ? undefined : v);
const postcodeKey = (s?: string | null) => (s ?? '').toUpperCase().replace(/\s+/g, '');

// Extraction checks that are handled (better) by the matching rules below.
const SUPERSEDED = new Set(['line_count_mismatch']);

export function buildOrderDraft(
  index: CatalogueIndex,
  input: {
    extracted: ExtractedOrderDto;
    customerMatch: CustomerMatch;
    isDuplicate: boolean;
    settings: RoutingSettings;
    now: Date;
  },
): OrderDraft {
  const { extracted, customerMatch, settings } = input;
  const customer = customerMatch.customer;
  const issues: IssueDraft[] = [];
  const add = (
    code: string,
    severity: IssueSeverity,
    message: string,
    opts: { lineNo?: number; blocking?: boolean } = {},
  ) =>
    issues.push({
      code,
      severity,
      message,
      blocking: Boolean(opts.blocking),
      ...(opts.lineNo ? { lineNo: opts.lineNo } : {}),
    });

  // Issues found while reading the document.
  for (const i of extracted.issues) {
    if (SUPERSEDED.has(i.code)) continue;
    add(i.code, i.severity, i.message, { lineNo: i.lineNo, blocking: i.code === 'no_lines' });
  }
  if (extracted.confidence < settings.amberConfidenceThreshold) {
    add(
      'low_confidence_read',
      'warning',
      `The document was read with low confidence (${Math.round(extracted.confidence * 100)}%)`,
    );
  }

  // Customer.
  if (!customer) {
    const names = customerMatch.candidates.map((c) => c.customer.name).join(', ');
    add(
      'customer_unknown',
      'warning',
      `Could not tell which customer sent this${names ? ` (closest: ${names})` : ''}`,
    );
  } else {
    if (customerMatch.method === 'name')
      add(
        'customer_by_name',
        'warning',
        `Matched to ${customer.name} by company name only - check it is the right account`,
      );
    if (customerMatch.conflict) add('customer_conflict', 'warning', customerMatch.conflict);
    if (customer.creditHold)
      add('credit_hold', 'error', `${customer.name} is on credit hold`, { blocking: true });
  }
  if (input.isDuplicate)
    add(
      'duplicate_po',
      'error',
      `PO ${extracted.poNumber} has already been received from ${customer?.name ?? 'this customer'}`,
      { blocking: true },
    );

  // Lines.
  const lines: LineDraft[] = extracted.lines.map((l) => {
    const m = matchLine(index, customer, l);
    const p = m.product;
    if (!p) {
      const what = [l.customerPartCode, l.description].filter(Boolean).join(' ');
      add('line_unmatched', 'warning', `No product found for "${what}"`, { lineNo: l.lineNo });
    }
    if (p && m.confidence < settings.greenConfidenceThreshold)
      add(
        'line_uncertain_match',
        'warning',
        `Matched to ${p.sku} with ${Math.round(m.confidence * 100)}% confidence`,
        { lineNo: l.lineNo },
      );
    for (const n of m.notes) add(n.code, 'warning', n.message, { lineNo: l.lineNo });

    let expected: ReturnType<CatalogueIndex['expectedPrice']> = null;
    if (p) {
      if (!p.active)
        add('sku_inactive', 'warning', `${p.sku} is marked inactive`, { lineNo: l.lineNo });
      if (
        p.stockQty !== undefined &&
        m.convertedQuantity !== undefined &&
        m.convertedQuantity > p.stockQty
      ) {
        add(
          'insufficient_stock',
          'info',
          `Only ${p.stockQty} of ${p.sku} in stock (ordered ${m.convertedQuantity})`,
          { lineNo: l.lineNo },
        );
      }
      expected = index.expectedPrice(customer, p, m.convertedQuantity ?? 1, input.now);
      if (expected && l.unitPrice !== null && expected.price > 0) {
        // Their price is per their unit; ours per our unit.
        const theirsInOurUnits = l.unitPrice / m.factor;
        const diffPct = (Math.abs(theirsInOurUnits - expected.price) / expected.price) * 100;
        if (diffPct > settings.priceTolerancePct) {
          const label = {
            contract: 'contract price',
            price_list: 'price list',
            default: 'list price',
          }[expected.source];
          add(
            'price_mismatch',
            'warning',
            `PO price ${money(theirsInOurUnits)} differs from the ${label} ${money(expected.price)} (${diffPct.toFixed(1)}%)`,
            { lineNo: l.lineNo },
          );
        }
      }
    }
    return {
      lineNo: l.lineNo,
      customerPartCode: undef(l.customerPartCode),
      description: undef(l.description),
      quantity: undef(l.quantity),
      unit: undef(l.unit),
      unitPrice: undef(l.unitPrice),
      lineTotal: undef(l.lineTotal),
      productId: p?.id,
      sku: p?.sku,
      productDescription: p?.description,
      matchMethod: m.method,
      matchConfidence: m.confidence,
      candidates: m.candidates.map((c) => ({
        productId: c.product.id,
        sku: c.product.sku,
        description: c.product.description,
        score: c.score,
      })),
      convertedQuantity: m.convertedQuantity,
      uom: p?.uom,
      conversionFactor: m.factor,
      expectedPrice: expected?.price,
      priceSource: expected?.source,
      stockQty: p?.stockQty,
      colour: 'amber',
      extractionConfidence: Math.min(
        l.confidence.quantity,
        Math.max(l.confidence.customerPartCode, l.confidence.description),
      ),
      edited: false,
    };
  });

  const unmatched = lines.filter((l) => !l.sku).length;
  if (lines.length && unmatched / lines.length > 0.5) {
    add(
      'unknown_items',
      'error',
      `${unmatched} of ${lines.length} lines could not be matched to products`,
      { blocking: true },
    );
  }

  // Delivery address the customer has never used.
  if (customer && extracted.deliveryAddress.postcode) {
    const known = customer.deliveryAddresses.map((a) => postcodeKey(a.postcode)).filter(Boolean);
    if (!known.includes(postcodeKey(extracted.deliveryAddress.postcode))) {
      add(
        'new_delivery_address',
        'warning',
        `Delivery to ${extracted.deliveryAddress.postcode} is not one of ${customer.name}'s known addresses`,
      );
    }
  }

  // Value of the order at our prices (or the document's where ours are unknown).
  let value: number | undefined;
  for (const l of lines) {
    const v =
      l.convertedQuantity !== undefined && l.expectedPrice !== undefined
        ? l.convertedQuantity * l.expectedPrice
        : (l.lineTotal ??
          (l.quantity !== undefined && l.unitPrice !== undefined
            ? l.quantity * l.unitPrice
            : undefined));
    if (v !== undefined) value = (value ?? 0) + v;
  }
  if (value !== undefined) value = Math.round(value * 100) / 100;
  if (
    value !== undefined &&
    settings.highValueThreshold !== null &&
    value > settings.highValueThreshold
  ) {
    add(
      'high_value',
      'warning',
      `Order value ${money(value)} is above the review threshold ${money(settings.highValueThreshold)}`,
    );
  }

  const routed = routeOrder({
    lines: lines.map((l) => ({
      lineNo: l.lineNo,
      matchConfidence: l.matchConfidence,
      quantity: l.quantity,
      sku: l.sku,
    })),
    issues: issues.map((i) => ({ ...i, resolved: false })),
    customerConfidence: customerMatch.confidence,
    extractionConfidence: extracted.confidence,
    settings,
  });
  routed.lineColours.forEach((c, i) => (lines[i]!.colour = c));
  return {
    lines,
    issues,
    value,
    colour: routed.colour,
    status: routed.status,
    confidence: routed.confidence,
  };
}
