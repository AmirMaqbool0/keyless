import { CLASSIFICATION_LABELS, type ClassificationDto, type EmailStatus } from '@keyless/shared';
import { Badge } from '../../components/ui';

const TONE = {
  new_order: 'green',
  amendment: 'amber',
  cancellation: 'red',
  quote_request: 'brand',
  delivery_query: 'brand',
  not_order: 'slate',
} as const;

export function ClassificationBadge({
  classification,
  status,
}: {
  classification: ClassificationDto | null;
  status: EmailStatus;
}) {
  if (status === 'failed') return <Badge tone="red">Failed</Badge>;
  if (!classification) return <Badge>Processing...</Badge>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Badge tone={TONE[classification.label]}>{CLASSIFICATION_LABELS[classification.label]}</Badge>
      <span className="text-xs text-slate-400" title={`${classification.method} classification`}>
        {classification.method === 'manual'
          ? 'set by reviewer'
          : `${Math.round(classification.confidence * 100)}%`}
      </span>
    </span>
  );
}
