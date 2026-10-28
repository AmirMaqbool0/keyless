import { Types } from 'mongoose';
import {
  computeOrderValue,
  type IssueSeverity,
} from '@keyless/shared';
import type { CatalogueIndex } from './catalogue';
import { findAttributeConflicts } from './attributeAgreement';
import { routeOrder, type RoutingSettings } from './route';
import type { IOrder, OrderIssue } from '../models/Order';

const postcodeKey = (s?: string | null) => (s ?? '').toUpperCase().replace(/\s+/g, '');
const money = (n: number) => `£${n.toFixed(2)}`;

export interface RevalidateOptions {
  catalogue: CatalogueIndex;
  settings: RoutingSettings;
  now?: Date;
  dismissedByUserId?: Types.ObjectId;
  dismissIssueId?: string;
}

/**
 * P1-2: Unified server-side validation and routing.
 * Re-evaluates all validation issues against current order state (after edits, re-match, or initial extraction):
 * - Resolves issues that no longer apply (e.g. customer_unknown when customer is selected, unmatched_sku when matched)
 * - Regenerates messages with current values (e.g. price mismatch with new expected price)
 * - Preserves reviewer manual dismissals
 * - Recomputes order value, line colours, order colour, confidence, and status (needs_review -> ready when clean)
 */
export function revalidateOrder(order: IOrder, options: RevalidateOptions): void {
  const { catalogue, settings, now = new Date() } = options;
  const customer = order.customerId ? catalogue.customer(order.customerId.toString()) : undefined;

  // Track existing dismissals so manual dismissals are preserved
  const dismissedMap = new Map<string, { dismissedBy?: Types.ObjectId; dismissedAt?: Date }>();
  for (const old of order.issues) {
    const key = `${old.code}:${old.lineNo ?? 'doc'}`;
    if (old.dismissedBy) {
      dismissedMap.set(key, { dismissedBy: old.dismissedBy, dismissedAt: old.dismissedAt });
    }
  }

  // Handle explicit dismissal if requested
  if (options.dismissIssueId && options.dismissedByUserId) {
    const target = order.issues.find((i) => i._id?.toString() === options.dismissIssueId);
    if (target) {
      const key = `${target.code}:${target.lineNo ?? 'doc'}`;
      dismissedMap.set(key, { dismissedBy: options.dismissedByUserId, dismissedAt: new Date() });
    }
  }

  // Computed new active issues
  type DraftIssue = {
    code: string;
    severity: IssueSeverity;
    blocking: boolean;
    message: string;
    lineNo?: number;
  };
  const activeIssues: DraftIssue[] = [];

  const add = (
    code: string,
    severity: IssueSeverity,
    message: string,
    opts: { lineNo?: number; blocking?: boolean } = {},
  ) => {
    activeIssues.push({
      code,
      severity,
      message,
      blocking: Boolean(opts.blocking),
      ...(opts.lineNo ? { lineNo: opts.lineNo } : {}),
    });
  };

  // 1. Extraction / document read issues: preserve existing ones
  for (const old of order.issues) {
    if (
      old.code === 'unreadable' ||
      old.code === 'partial_extraction' ||
      old.code === 'low_confidence_read' ||
      old.code === 'no_lines'
    ) {
      add(old.code, old.severity, old.message, { lineNo: old.lineNo, blocking: old.blocking });
    }
  }

  // 2. Customer validation
  if (!customer) {
    add('customer_unknown', 'warning', 'Could not tell which customer sent this');
  } else {
    if (customer.creditHold) {
      add('credit_hold', 'error', `${customer.name} is on credit hold`, { blocking: true });
    }
    if (order.deliveryAddress?.postcode && customer.deliveryAddresses?.length > 0) {
      const known = customer.deliveryAddresses.map((a) => postcodeKey(a.postcode));
      if (!known.includes(postcodeKey(order.deliveryAddress.postcode))) {
        add(
          'new_delivery_address',
          'warning',
          `Delivery to ${order.deliveryAddress.postcode} is not one of ${customer.name}'s known addresses`,
        );
      }
    }
  }

  // 3. Line validation
  for (const line of order.lines) {
    const lNum = line.lineNo;
    const prod = line.productId
      ? catalogue.productById(line.productId.toString())
      : line.sku
        ? catalogue.productBySku(line.sku)
        : null;

    if (!prod && !line.sku) {
      const what = [line.customerPartCode, line.description].filter(Boolean).join(' ') || `Line ${lNum}`;
      add('line_unmatched', 'warning', `No product found for "${what}"`, { lineNo: lNum });
      continue;
    }

    if (prod) {
      if (!prod.active) {
        add('sku_inactive', 'warning', `${prod.sku} is marked inactive`, { lineNo: lNum });
      }
      if (
        prod.stockQty !== undefined &&
        line.convertedQuantity !== undefined &&
        line.convertedQuantity > prod.stockQty
      ) {
        add(
          'insufficient_stock',
          'info',
          `Only ${prod.stockQty} of ${prod.sku} in stock (ordered ${line.convertedQuantity})`,
          { lineNo: lNum },
        );
      }

      // Pack size multiple check
      if (
        line.convertedQuantity !== undefined &&
        !Number.isInteger(line.convertedQuantity)
      ) {
        add(
          'pack_multiple',
          'error',
          `Quantity ${line.convertedQuantity} is not a multiple of the pack size`,
          { lineNo: lNum, blocking: true },
        );
      }

      // Expected price check with current catalogue / contract values
      if (customer) {
        const expected = catalogue.expectedPrice(
          customer,
          prod,
          line.convertedQuantity ?? line.quantity ?? 1,
          order.orderDate ? new Date(order.orderDate) : now,
        );
        if (expected) {
          line.expectedPrice = expected.price;
          line.priceSource = expected.source;

          if (line.unitPrice !== undefined && line.unitPrice !== null && expected.price > 0) {
            const factor = line.conversionFactor || 1;
            const theirsInOurUnits = line.unitPrice / factor;
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
                { lineNo: lNum },
              );
            }
          }
        }
      }

      // Code / description mismatch check (only if not manually confirmed/edited)
      if (!line.edited && line.description) {
        const sim = catalogue.search.scoreProduct
          ? catalogue.search.scoreProduct(line.description, prod)
          : 1;
        const conflicts = findAttributeConflicts(line.description, prod.description);
        if (sim < settings.codeDescriptionMismatchThreshold || conflicts.length > 0) {
          add(
            'code_description_mismatch',
            'warning',
            `SKU ${prod.sku} description differs from catalogue (${prod.description})`,
            { lineNo: lNum },
          );
        }
      }
    }
  }

  // 4. Aggregate issues
  const unmatchedCount = order.lines.filter((l) => !l.sku && !l.productId).length;
  if (order.lines.length > 0 && unmatchedCount / order.lines.length > 0.5) {
    add(
      'unknown_items',
      'error',
      `${unmatchedCount} of ${order.lines.length} lines could not be matched to products`,
      { blocking: true },
    );
  }

  // Value calculation
  const valResult = computeOrderValue(order.lines);
  order.value = valResult.value ?? undefined;
  order.valueEstimated = valResult.isEstimated;
  order.expectedValue = valResult.expectedValue ?? undefined;

  if (
    order.value !== undefined &&
    settings.highValueThreshold !== null &&
    order.value > settings.highValueThreshold
  ) {
    add(
      'high_value',
      'warning',
      `Order value ${money(order.value)} is above the review threshold ${money(settings.highValueThreshold)}`,
    );
  }

  // 5. Merge active issues with existing issues, preserving dismissals and existing issue IDs
  const existingMap = new Map<string, OrderIssue>();
  for (const old of order.issues) {
    const key = `${old.code}:${old.lineNo ?? 'doc'}`;
    existingMap.set(key, old);
  }

  const mergedIssues: OrderIssue[] = [];
  for (const act of activeIssues) {
    const key = `${act.code}:${act.lineNo ?? 'doc'}`;
    const existing = existingMap.get(key);
    const dismissed = dismissedMap.get(key);

    const issueDoc: OrderIssue = {
      _id: existing?._id ?? new Types.ObjectId(),
      code: act.code,
      severity: act.severity,
      blocking: act.blocking,
      message: act.message,
      lineNo: act.lineNo,
      resolved: Boolean(dismissed),
      dismissedBy: dismissed?.dismissedBy,
      dismissedAt: dismissed?.dismissedAt,
    };
    mergedIssues.push(issueDoc);
  }
  order.issues = mergedIssues;

  // 6. Recompute routing: line colours, order colour, confidence, and status
  const customerConfidence = customer ? 1.0 : order.customerMatch?.confidence ?? 0;
  const routable = routeOrder({
    lines: order.lines.map((l) => ({
      lineNo: l.lineNo,
      matchConfidence: l.matchConfidence ?? (l.sku ? 0.95 : 0),
      quantity: l.quantity,
      sku: l.sku,
    })),
    issues: order.issues,
    customerConfidence,
    extractionConfidence: order.extractionConfidence ?? 0.8,
    settings,
  });

  routable.lineColours.forEach((colour, i) => {
    if (order.lines[i]) order.lines[i]!.colour = colour;
  });
  order.colour = routable.colour;
  order.confidence = routable.confidence;
  order.confidenceHint = routable.confidenceHint ?? undefined;

  // Only update status if the order is still in reviewable lifecycle
  if (['needs_review', 'ready', 'on_hold', 'duplicate'].includes(order.status)) {
    order.status = routable.status;
  }
}
