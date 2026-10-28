import clsx from 'clsx';
import { ORDER_STATUS_LABELS, type OrderStatus, type RouteColour } from '@keyless/shared';

const DOT: Record<RouteColour, string> = {
  green: 'bg-emerald-500 ring-2 ring-emerald-200/60',
  amber: 'bg-amber-500 ring-2 ring-amber-200/60',
  red: 'bg-rose-500 ring-2 ring-rose-200/60',
};
const LABEL: Record<RouteColour, string> = {
  green: 'Ready to approve (100% matched)',
  amber: 'Needs review (Check item/price)',
  red: 'Blocked (Credit hold/Duplicate)',
};

export function ColourDot({ colour, className }: { colour: RouteColour; className?: string }) {
  return (
    <span
      className={clsx('inline-block size-2 shrink-0 rounded-full', DOT[colour], className)}
      title={LABEL[colour]}
      aria-label={LABEL[colour]}
    />
  );
}

export function StatusPill({ status, colour }: { status: OrderStatus; colour: RouteColour }) {
  const tone = {
    green: 'bg-emerald-50 text-emerald-700 ring-emerald-200/80',
    amber: 'bg-amber-50 text-amber-800 ring-amber-200/80',
    red: 'bg-rose-50 text-rose-700 ring-rose-200/80',
  }[colour];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1',
        tone,
      )}
    >
      <ColourDot colour={colour} />
      {ORDER_STATUS_LABELS[status]}
    </span>
  );
}

export const money = (n: number | null | undefined, currency = 'GBP') =>
  n === null || n === undefined ? '-' : n.toLocaleString('en-GB', { style: 'currency', currency });

/** "2 h", "3 d": how long an order has been waiting. */
export function age(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins} min`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h`;
  return `${Math.round(mins / 1440)} d`;
}
