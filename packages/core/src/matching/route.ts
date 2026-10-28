import type { IssueSeverity, OrderStatus, RouteColour } from '@keyless/shared';

/*
 * Green / amber / red routing (spec section 9). Works on stored order data so it can re-run
 * after edits (M6), after an amendment arrives, or after re-matching, with the same rules.
 *  - red:   any unresolved blocking issue (credit hold, duplicate PO, unreadable, mostly unknown
 *           items) -> on_hold, or duplicate
 *  - amber: anything uncertain or any unresolved warning -> needs_review
 *  - green: customer known, every line matched above the green threshold, nothing to check -> ready
 */

export type RoutingSettings = {
  greenConfidenceThreshold: number;
  amberConfidenceThreshold: number;
  priceTolerancePct: number;
  highValueThreshold: number | null;
  codeDescriptionMismatchThreshold: number;
};

export const DEFAULT_ROUTING: RoutingSettings = {
  greenConfidenceThreshold: 0.9,
  amberConfidenceThreshold: 0.6,
  priceTolerancePct: 2,
  highValueThreshold: null,
  codeDescriptionMismatchThreshold: 0.5,
};

export type RoutableLine = {
  lineNo: number;
  matchConfidence: number;
  quantity?: number | null;
  sku?: string | null;
};
export type RoutableIssue = {
  code: string;
  severity: IssueSeverity;
  blocking: boolean;
  resolved: boolean;
  lineNo?: number | null;
};

export type RouteResult = {
  lineColours: RouteColour[];
  colour: RouteColour;
  status: OrderStatus;
  confidence: number;
  confidenceHint: string | null;
};

/** Statuses routing may change. Once approved, an order's status is the reviewer's/ERP's. */
export const REVIEWABLE: OrderStatus[] = ['needs_review', 'ready', 'on_hold', 'duplicate'];

/**
 * Computes overall order confidence (0.0 - 1.0) and the weakest area hint.
 *
 * Weighting formula:
 * - Line matching: 50% (mean match quality of product lines)
 * - Document extraction: 30% (OCR/LLM field extraction confidence)
 * - Customer identification: 20% (sender/domain/account number confidence)
 *
 * Rationale:
 * High-quality line items and clear document extraction are valuable signals that
 * should be reflected in the overall score even when the customer is unrecognised.
 * An unknown customer (customerConfidence = 0) contributes 0 to the customer weight,
 * bringing total confidence to at most 80% (amber range), but does not zero out the
 * entire score to 0%. The order is still safely routed to 'needs_review' (amber)
 * because colour routing independently requires customerConfidence >= green threshold.
 */
export function computeOrderConfidence(input: {
  customerConfidence: number;
  extractionConfidence: number;
  lineConfidence: number;
  hasUnmatchedLines?: boolean;
}): { confidence: number; confidenceHint: string | null } {
  const { customerConfidence, extractionConfidence, lineConfidence, hasUnmatchedLines } = input;

  const weighted =
    0.50 * lineConfidence +
    0.30 * extractionConfidence +
    0.20 * customerConfidence;

  const confidence = Math.round(Math.min(1.0, Math.max(0.0, weighted)) * 100) / 100;

  let confidenceHint: string | null = null;
  if (confidence < 0.95) {
    if (customerConfidence === 0) {
      confidenceHint = 'Customer unknown';
    } else if (hasUnmatchedLines || lineConfidence < 0.6) {
      confidenceHint = hasUnmatchedLines ? 'Unmatched lines' : 'Low line match';
    } else if (extractionConfidence < 0.7) {
      confidenceHint = 'Low read confidence';
    } else if (customerConfidence < 0.75) {
      confidenceHint = 'Customer unverified';
    } else if (lineConfidence < 0.85) {
      confidenceHint = 'Line review needed';
    }
  }

  return { confidence, confidenceHint };
}

export function routeOrder(input: {
  lines: RoutableLine[];
  issues: RoutableIssue[];
  customerConfidence: number;
  extractionConfidence: number;
  settings: RoutingSettings;
}): RouteResult {
  const { settings } = input;
  const open = input.issues.filter((i) => !i.resolved);
  const lineColours = input.lines.map((l): RouteColour => {
    if (!l.sku || l.quantity === null || l.quantity === undefined || l.quantity <= 0) return 'red';
    const lineProblems = open.some((i) => i.lineNo === l.lineNo && i.severity !== 'info');
    return l.matchConfidence >= settings.greenConfidenceThreshold && !lineProblems
      ? 'green'
      : 'amber';
  });

  const blocking = open.filter((i) => i.blocking);
  let colour: RouteColour;
  if (blocking.length) colour = 'red';
  else if (
    !input.lines.length ||
    lineColours.some((c) => c !== 'green') ||
    open.some((i) => i.severity !== 'info') ||
    input.customerConfidence < settings.greenConfidenceThreshold ||
    input.extractionConfidence < settings.amberConfidenceThreshold
  ) {
    colour = 'amber';
  } else colour = 'green';

  const status: OrderStatus =
    colour === 'red'
      ? blocking.some((i) => i.code === 'duplicate_po')
        ? 'duplicate'
        : 'on_hold'
      : colour === 'amber'
        ? 'needs_review'
        : 'ready';

  const lineConf = input.lines.length
    ? input.lines.reduce((s, l) => s + l.matchConfidence, 0) / input.lines.length
    : 0;

  const { confidence, confidenceHint } = computeOrderConfidence({
    customerConfidence: input.customerConfidence,
    extractionConfidence: input.extractionConfidence,
    lineConfidence: lineConf,
    hasUnmatchedLines: input.lines.some((l) => !l.sku),
  });

  return { lineColours, colour, status, confidence, confidenceHint };
}
