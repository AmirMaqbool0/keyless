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
};

export const DEFAULT_ROUTING: RoutingSettings = {
  greenConfidenceThreshold: 0.9,
  amberConfidenceThreshold: 0.6,
  priceTolerancePct: 2,
  highValueThreshold: null,
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
};

/** Statuses routing may change. Once approved, an order's status is the reviewer's/ERP's. */
export const REVIEWABLE: OrderStatus[] = ['needs_review', 'ready', 'on_hold', 'duplicate'];

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
  const confidence =
    Math.round(Math.min(input.extractionConfidence, input.customerConfidence, lineConf) * 100) /
    100;
  return { lineColours, colour, status, confidence };
}
