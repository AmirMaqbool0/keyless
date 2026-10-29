import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import type {
  CorrectionDto,
  CustomerDto,
  MatchCandidateDto,
  MatchMethod,
  OrderDetailDto,
  OrderIssueDto,
  OutboundEmailDto,
  Paginated,
  ProductDto,
  UpdateOrderInput,
} from '@keyless/shared';
import { computeUomConversion } from '@keyless/shared';
import { SearchInput, useDebounced } from '../../components/data';
import { Badge, Button, Card, FormError, FullPageSpinner, Modal } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { useHasRole } from '../../lib/session';
import { ColourDot, StatusPill, money } from './OrderBits';

const METHOD_LABEL: Record<MatchMethod, string> = {
  xref_code: 'their code (learned)',
  xref_description: 'their description (learned)',
  sku: 'our SKU',
  barcode: 'barcode',
  fuzzy: 'description search',
  manual: 'set by reviewer',
  none: 'no match',
};

const CUSTOMER_METHOD: Record<OrderDetailDto['customerMatch']['method'], string> = {
  sender: 'known sender address',
  domain: 'sender email domain',
  account_number: 'account number on the PO',
  name: 'company name on the PO',
  delivery_address: 'delivery address on the PO',
  forwarded_sender: 'original sender inside forwarded email',
  manual: 'chosen by reviewer',
  none: 'not identified',
};

function IssueList({
  issues,
  onDismiss,
  canReview,
}: {
  issues: OrderIssueDto[];
  onDismiss?: (issueId: string) => void;
  canReview?: boolean;
}) {
  const open = issues.filter((i) => !i.resolved);
  if (!open.length) return <p className="text-sm text-emerald-700 font-medium">Nothing to check.</p>;
  return (
    <ul className="space-y-1.5 text-sm">
      {open.map((i) => (
        <li key={i.id} className="flex items-center justify-between gap-2">
          <div className="flex items-start gap-2">
            <span
              className={clsx(
                'mt-0.5 shrink-0 rounded px-1.5 text-xs font-medium',
                i.blocking
                  ? 'bg-red-100 text-red-800'
                  : i.severity === 'info'
                    ? 'bg-slate-100 text-slate-600'
                    : 'bg-amber-100 text-amber-900',
              )}
            >
              {i.blocking ? 'Blocking' : i.severity === 'info' ? 'Note' : 'Check'}
            </span>
            <span className="text-slate-700">
              {i.lineNo && <span className="font-medium">Line {i.lineNo}: </span>}
              {i.message}
            </span>
          </div>
          {!i.blocking && canReview && onDismiss && (
            <button
              type="button"
              onClick={() => onDismiss(i.id)}
              className="text-xs text-slate-400 hover:text-slate-700 underline shrink-0 cursor-pointer"
              title="Dismiss warning"
            >
              Dismiss
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function OrderDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const canReview = useHasRole('reviewer');

  // Query order data
  const order = useQuery({
    queryKey: ['order', id],
    queryFn: () => api.get<OrderDetailDto>(`/api/orders/${id}`),
  });

  // Query corrections history
  const corrections = useQuery({
    queryKey: ['order-corrections', id],
    queryFn: () => api.get<CorrectionDto[]>(`/api/orders/${id}/corrections`),
    enabled: Boolean(order.data),
  });

  // View mode: 'split' | 'review' | 'doc'
  const [viewMode, setViewMode] = useState<'split' | 'review' | 'doc'>('split');

  // Local editable state
  const [poNumber, setPoNumber] = useState('');
  const [orderDate, setOrderDate] = useState('');
  const [requestedDeliveryDate, setRequestedDeliveryDate] = useState('');
  const [line1, setLine1] = useState('');
  const [city, setCity] = useState('');
  const [postcode, setPostcode] = useState('');
  const [notes, setNotes] = useState('');
  const [currency, setCurrency] = useState('GBP');

  // Customer selection
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [selectedCustomerName, setSelectedCustomerName] = useState<string | null>(null);
  const [selectedCustomerCode, setSelectedCustomerCode] = useState<string | null>(null);
  const [rememberSender, setRememberSender] = useState(false);

  // Line items editable state
  type EditableLine = OrderDetailDto['lines'][number] & { dirty?: boolean };
  const [lines, setLines] = useState<EditableLine[]>([]);
  const [expandedLineId, setExpandedLineId] = useState<string | null>(null);

  // Modals state
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [productSearchOpen, setProductSearchOpen] = useState(false);
  const [targetLineId, setTargetLineId] = useState<string | null>(null);
  const [productSearchTerm, setProductSearchTerm] = useState('');
  const [customerSearchOpen, setCustomerSearchOpen] = useState(false);
  const [customerSearchTerm, setCustomerSearchTerm] = useState('');

  // Outbound email modal state
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [activeEmailId, setActiveEmailId] = useState<string | null>(null);
  const [emailTo, setEmailTo] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');

  const outboundEmails = useQuery({
    queryKey: ['order-emails', id],
    queryFn: async () => {
      const res = await api.get<{ items?: OutboundEmailDto[] } | OutboundEmailDto[]>(
        `/api/orders/${id}/emails`,
      );
      return Array.isArray(res) ? res : res.items ?? [];
    },
    enabled: emailModalOpen || Boolean(order.data),
  });

  const draftMutation = useMutation({
    mutationFn: (type: 'acknowledgment' | 'clarification') =>
      api.post<OutboundEmailDto>(`/api/orders/${id}/emails/draft`, { type }),
    onSuccess: (draft) => {
      toast.success(`Draft ${draft.type} email generated`);
      void qc.invalidateQueries({ queryKey: ['order-emails', id] });
      setActiveEmailId(draft.id);
      setEmailTo(draft.to);
      setEmailSubject(draft.subject);
      setEmailBody(draft.body);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const saveEmailMutation = useMutation({
    mutationFn: (emailId: string) =>
      api.patch<OutboundEmailDto>(`/api/orders/${id}/emails/${emailId}`, {
        to: emailTo,
        subject: emailSubject,
        body: emailBody,
      }),
    onSuccess: () => {
      toast.success('Draft email saved');
      void qc.invalidateQueries({ queryKey: ['order-emails', id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const sendEmailMutation = useMutation({
    mutationFn: (emailId: string) =>
      api.post<OutboundEmailDto>(`/api/orders/${id}/emails/${emailId}/send`),
    onSuccess: () => {
      toast.success('Email sent to customer successfully!');
      void qc.invalidateQueries({ queryKey: ['order-emails', id] });
      setActiveEmailId(null);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // Sync server data to local edit state
  useEffect(() => {
    if (order.data) {
      const o = order.data;
      setPoNumber(o.poNumber ?? '');
      setOrderDate(o.orderDate ?? '');
      setRequestedDeliveryDate(o.requestedDeliveryDate ?? '');
      setLine1(o.deliveryAddress.line1 ?? '');
      setCity(o.deliveryAddress.city ?? '');
      setPostcode(o.deliveryAddress.postcode ?? '');
      setNotes(o.notes ?? '');
      setCurrency(o.currency ?? 'GBP');
      setSelectedCustomerId(o.customer.id);
      setSelectedCustomerName(o.customer.name);
      setSelectedCustomerCode(o.customer.accountCode);
      setLines(o.lines.map((l) => ({ ...l })));
    }
  }, [order.data]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['order', id] });
    void qc.invalidateQueries({ queryKey: ['order-corrections', id] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['order-counts'] });
    void order.refetch();
  };

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: () => {
      const payload: UpdateOrderInput = {
        poNumber: poNumber.trim() || null,
        orderDate: orderDate || null,
        requestedDeliveryDate: requestedDeliveryDate || null,
        deliveryAddress: {
          line1: line1.trim() || null,
          city: city.trim() || null,
          postcode: postcode.trim() || null,
        },
        notes: notes.trim() || null,
        currency,
        customerId: selectedCustomerId,
        rememberSender: Boolean(selectedCustomerId && rememberSender),
        lines: lines.map((l) => ({
          id: l.id,
          lineNo: l.lineNo,
          customerPartCode: l.customerPartCode ?? null,
          description: l.description ?? null,
          quantity: l.quantity,
          unit: l.unit ?? null,
          unitPrice: l.unitPrice,
          productId: l.match.productId,
          sku: l.match.sku,
          conversionFactor: l.conversionFactor,
        })),
      };
      return api.patch(`/api/orders/${id}`, payload);
    },
    onSuccess: () => {
      toast.success('Order saved! Learned cross-references have been updated.');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // Approve mutation
  const approveMutation = useMutation({
    mutationFn: () =>
      api.post<{ status: string; erpReference: string | null }>(`/api/orders/${id}/approve`),
    onSuccess: (res) => {
      if (res.status === 'pushed') {
        toast.success(`Approved & pushed to ERP! Reference: ${res.erpReference ?? 'OK'}`);
      } else {
        toast.success('Order approved!');
      }
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // Hold mutation
  const holdMutation = useMutation({
    mutationFn: () => api.post(`/api/orders/${id}/hold`),
    onSuccess: () => {
      toast.success('Order placed on hold');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // Reject mutation
  const rejectMutation = useMutation({
    mutationFn: (reason: string) => api.post(`/api/orders/${id}/reject`, { reason }),
    onSuccess: () => {
      toast.success('Order rejected');
      setRejectOpen(false);
      setRejectReason('');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // Rematch mutation
  const rematch = useMutation({
    mutationFn: () => api.post(`/api/orders/${id}/rematch`),
    onSuccess: () => {
      toast.success('Re-matching against the current catalogue...');
      setTimeout(refresh, 1000);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // Re-extract mutation
  const reExtract = useMutation({
    mutationFn: () => api.post(`/api/orders/${id}/re-extract`),
    onSuccess: () => {
      toast.success('Re-extracting document with AI...');
      setTimeout(refresh, 3000);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // Retry ERP push mutation (M7)
  const retryPushMutation = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; status: string; erpReference: string | null; lastPushError: string | null }>(
        `/api/orders/${id}/retry-push`,
      ),
    onSuccess: (res) => {
      if (res.status === 'pushed') {
        toast.success(`Pushed to ERP successfully! Ref: ${res.erpReference}`);
      } else {
        toast.error(`Push failed: ${res.lastPushError ?? 'Unknown error'}`);
      }
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // Dismiss issue mutation (P1-2)
  const dismissIssueMutation = useMutation({
    mutationFn: (issueId: string) =>
      api.post(`/api/orders/${id}/issues/${issueId}/dismiss`),
    onSuccess: () => {
      toast.success('Warning dismissed');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!canReview) return;
      // Ctrl/Cmd + S -> Save
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveMutation.mutate();
      }
      // Alt + A or Ctrl/Cmd + Enter -> Approve
      if ((e.altKey && e.key.toLowerCase() === 'a') || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) {
        e.preventDefault();
        approveMutation.mutate();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canReview, saveMutation, approveMutation]);

  // Product search debounced query
  const debouncedProductTerm = useDebounced(productSearchTerm, 200);
  const productSearchResults = useQuery({
    queryKey: ['search-products', debouncedProductTerm],
    queryFn: () =>
      api.get<Paginated<ProductDto>>(`/api/products?q=${encodeURIComponent(debouncedProductTerm)}&pageSize=8`),
    enabled: productSearchOpen,
  });

  // Customer search debounced query
  const debouncedCustomerTerm = useDebounced(customerSearchTerm, 200);
  const customerSearchResults = useQuery({
    queryKey: ['search-customers', debouncedCustomerTerm],
    queryFn: () =>
      api.get<Paginated<CustomerDto>>(`/api/customers?q=${encodeURIComponent(debouncedCustomerTerm)}&pageSize=8`),
    enabled: customerSearchOpen,
  });

  // Handle line product change
  const applyProductToLine = (lineId: string, prod: { id: string; sku: string; description: string; defaultPrice?: number | null; packSize?: number | null; uom?: string | null }) => {
    setLines((prev) =>
      prev.map((l) => {
        if (l.id !== lineId) return l;
        const uomRes = computeUomConversion({
          customerQty: l.quantity,
          customerUnit: l.unit,
          customerDescription: l.description,
          productUom: prod.uom,
          productPackSize: prod.packSize,
          productDescription: prod.description,
        });
        const factor = uomRes.factor;
        const converted = uomRes.convertedQuantity;
        return {
          ...l,
          dirty: true,
          match: {
            ...l.match,
            productId: prod.id,
            sku: prod.sku,
            description: prod.description,
            method: 'manual',
            confidence: 1.0,
          },
          conversionFactor: factor,
          convertedQuantity: converted,
          uom: prod.uom ?? l.uom,
          expectedPrice: prod.defaultPrice ?? l.expectedPrice,
          colour: factor !== 1 ? 'amber' : 'green',
        };
      }),
    );
    toast.success(`Assigned SKU: ${prod.sku}`);
  };

  if (order.isPending) return <FullPageSpinner />;
  if (order.isError) return <FormError message={errorMessage(order.error)} />;

  const o = order.data;
  const isFinalized = !['needs_review', 'ready', 'on_hold', 'duplicate'].includes(o.status);

  return (
    <>
      {/* Top Header and Action Bar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <div className="flex items-center gap-3">
          <Link to="/orders" className="text-sm font-medium text-slate-500 hover:text-slate-900">
            &larr; Orders
          </Link>
          <span className="text-slate-300">|</span>
          <h1 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <span>{selectedCustomerName || o.customer.name || 'Unidentified customer'}</span>
            <span className="font-mono text-sm font-normal text-slate-500">
              PO: {poNumber || o.poNumber || '(none)'}
            </span>
          </h1>
          <StatusPill status={o.status} colour={o.colour} />
          {o.autoApproved && (
            <span className="rounded-full border border-purple-300 bg-purple-50 px-2.5 py-0.5 text-xs font-semibold text-purple-800 flex items-center gap-1">
              ⚡ Auto-approved {o.autoApprovedRuleName ? `(${o.autoApprovedRuleName})` : ''}
            </span>
          )}
          {o.erpReference && (
            <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
              ERP Ref: {o.erpReference}
            </span>
          )}
          {o.approvedBy && (
            <span className="text-xs text-slate-500">
              Approved by <strong className="text-slate-700">{o.approvedBy.name}</strong>
            </span>
          )}
        </div>

        {/* Action Controls & Shortcuts */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Customer Email Drawer Button */}
          <Button
            variant="secondary"
            onClick={() => {
              setEmailModalOpen(true);
              const list = outboundEmails.data ?? [];
              const latest = list[0];
              if (latest && !activeEmailId) {
                setActiveEmailId(latest.id);
                setEmailTo(latest.to);
                setEmailSubject(latest.subject);
                setEmailBody(latest.body);
              }
            }}
          >
            Customer Email
          </Button>

          {/* View mode toggle */}
          <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 text-xs font-medium">
            <button
              type="button"
              onClick={() => setViewMode('split')}
              className={clsx(
                'rounded px-2.5 py-1',
                viewMode === 'split' ? 'bg-slate-100 text-slate-900 font-semibold' : 'text-slate-600 hover:text-slate-900',
              )}
              aria-label="Split view (document and order side-by-side)"
              title="Split view (document and order side-by-side)"
            >
              Split View
            </button>
            <button
              type="button"
              onClick={() => setViewMode('review')}
              className={clsx(
                'rounded px-2.5 py-1',
                viewMode === 'review' ? 'bg-slate-100 text-slate-900 font-semibold' : 'text-slate-600 hover:text-slate-900',
              )}
              aria-label="Order only view"
              title="Order only view"
            >
              Order Only
            </button>
            {o.source.attachmentUrl && (
              <button
                type="button"
                onClick={() => setViewMode('doc')}
                className={clsx(
                  'rounded px-2.5 py-1',
                  viewMode === 'doc' ? 'bg-slate-100 text-slate-900 font-semibold' : 'text-slate-600 hover:text-slate-900',
                )}
                aria-label="Document only view"
                title="Document only view"
              >
                Doc Only
              </button>
            )}
          </div>

          {canReview && o.status === 'push_failed' && (
            <Button
              variant="primary"
              loading={retryPushMutation.isPending}
              onClick={() => retryPushMutation.mutate()}
              className="bg-amber-600 hover:bg-amber-700"
            >
              Retry Push
            </Button>
          )}

          {canReview && !isFinalized && (
            <>
              {o.issues.some((i) => i.code === 'unreadable_document' || i.code === 'needs_vision') && (
                <Button
                  variant="secondary"
                  loading={reExtract.isPending}
                  onClick={() => reExtract.mutate()}
                  title="Re-extract document with AI"
                  className="bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100"
                >
                  Re-extract
                </Button>
              )}
              <Button
                variant="secondary"
                loading={rematch.isPending}
                onClick={() => rematch.mutate()}
                title="Re-run matching rules"
              >
                Re-match
              </Button>
              <Button
                variant="secondary"
                loading={holdMutation.isPending}
                onClick={() => holdMutation.mutate()}
              >
                Hold
              </Button>
              <Button
                variant="danger"
                onClick={() => setRejectOpen(true)}
              >
                Reject
              </Button>
              <Button
                variant="secondary"
                loading={saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
                title="Save edits (Ctrl+S)"
              >
                Save <kbd className="ml-1 text-xs opacity-60">Ctrl+S</kbd>
              </Button>
              <Button
                variant="primary"
                loading={approveMutation.isPending}
                onClick={() => approveMutation.mutate()}
                disabled={!selectedCustomerId}
                className="bg-emerald-600 hover:bg-emerald-700"
                title="Approve order (Alt+A or Ctrl+Enter)"
              >
                Approve &amp; Push <kbd className="ml-1 text-xs opacity-75">Alt+A</kbd>
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Push failure alert banner */}
      {o.status === 'push_failed' && (
        <div className="flex items-center justify-between rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="flex items-center gap-2">
            <span className="font-bold text-amber-950">
              {o.lastPushError?.toLowerCase().includes('no active connector')
                ? 'Approved — not sent.'
                : 'ERP Push Failed:'}
            </span>
            <span>
              {o.lastPushError?.toLowerCase().includes('no active connector') ? (
                <>
                  No ERP connector is set up.{' '}
                  <Link
                    to="/settings/integrations"
                    className="font-medium underline hover:text-amber-700"
                  >
                    Configure integrations
                  </Link>
                </>
              ) : (
                o.lastPushError || 'The ERP connector returned an error while pushing this order.'
              )}
            </span>
          </div>
          {canReview && (
            <Button
              variant="secondary"
              className="px-2.5 py-1 text-xs"
              loading={retryPushMutation.isPending}
              onClick={() => retryPushMutation.mutate()}
            >
              Retry Now
            </Button>
          )}
        </div>
      )}

      {/* Main Content Area */}
      <div className={clsx('grid gap-4', viewMode === 'split' ? 'lg:grid-cols-12' : 'grid-cols-1')}>
        {/* Left Pane: Document Viewer */}
        {(viewMode === 'split' || viewMode === 'doc') && (
          <div className={clsx(viewMode === 'split' ? 'lg:col-span-5' : 'col-span-1')}>
            <Card
              title={
                <div className="flex items-center justify-between">
                  <span>Source Document</span>
                  {o.source.attachmentUrl && (
                    <a
                      href={o.source.attachmentUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-normal text-brand-600 hover:underline"
                    >
                      Open in new tab &nearr;
                    </a>
                  )}
                </div>
              }
              description={o.source.label}
              className="h-[calc(100vh-140px)] flex flex-col"
            >
              {o.source.attachmentUrl ? (
                o.source.mimeType === 'application/pdf' || o.source.label.toLowerCase().endsWith('.pdf') ? (
                  <iframe
                    title="Source PO Document"
                    src={o.source.attachmentUrl}
                    className="h-full w-full rounded border border-slate-200"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center overflow-auto bg-slate-50 p-2">
                    <img
                      src={o.source.attachmentUrl}
                      alt="Source attachment"
                      className="max-h-full rounded border border-slate-200 object-contain shadow-xs"
                    />
                  </div>
                )
              ) : (
                <div className="h-full overflow-y-auto rounded bg-slate-50 p-4 text-sm text-slate-800">
                  <p className="font-semibold text-slate-700">Email Body Order</p>
                  <p className="mt-1 text-xs text-slate-500">From: {o.email.from}</p>
                  <p className="text-xs text-slate-500">Subject: {o.email.subject}</p>
                  <hr className="my-3 border-slate-200" />
                  <p className="text-xs text-slate-600">
                    Order extracted from original email text. Check inbox for full body details.
                  </p>
                  <Link
                    to={`/inbox/${o.email.id}`}
                    className="mt-2 inline-block text-xs font-medium text-brand-600 hover:underline"
                  >
                    View raw email &rarr;
                  </Link>
                </div>
              )}
            </Card>
          </div>
        )}

        {/* Right Pane: Review & Edit Workspace */}
        {(viewMode === 'split' || viewMode === 'review') && (
          <div className={clsx('space-y-4', viewMode === 'split' ? 'lg:col-span-7' : 'col-span-1')}>
            {/* Customer & Header Bar */}
            <div className="grid gap-4 md:grid-cols-2">
              {/* Customer Selector */}
              <Card
                title={
                  <div className="flex items-center justify-between">
                    <span>Customer</span>
                    {canReview && !isFinalized && (
                      <button
                        type="button"
                        onClick={() => {
                          setCustomerSearchTerm('');
                          setCustomerSearchOpen(true);
                        }}
                        className="text-xs font-normal text-brand-600 hover:underline"
                      >
                        {selectedCustomerId ? 'Change customer' : 'Select customer'}
                      </button>
                    )}
                  </div>
                }
              >
                {selectedCustomerId ? (
                  <div>
                    <p className="text-base font-semibold text-slate-900">{selectedCustomerName}</p>
                    <p className="font-mono text-xs text-slate-500">Account: {selectedCustomerCode}</p>
                    <div className="mt-2 flex items-center gap-2 text-xs text-slate-600">
                      <Badge tone="green">Matched</Badge>
                      {o.customerMatch.method === 'manual' ||
                      (selectedCustomerId && selectedCustomerId !== o.customerMatch.customerId) ? (
                        <span>Picked by reviewer</span>
                      ) : o.customerMatch.method === 'none' ? (
                        <span>Picked by reviewer</span>
                      ) : (
                        <span>
                          Identified by {CUSTOMER_METHOD[o.customerMatch.method] ?? o.customerMatch.method}
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm font-semibold text-amber-800">No customer identified</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Sender: {o.email.from || 'unknown sender'}
                    </p>
                    {o.customerMatch.candidates.length > 0 && (
                      <div className="mt-2 space-y-1">
                        <p className="text-xs font-medium text-slate-600">Suggestions:</p>
                        <div className="flex flex-wrap gap-1.5">
                          {o.customerMatch.candidates.map((c) => (
                            <button
                              key={c.customerId}
                              type="button"
                              onClick={() => {
                                setSelectedCustomerId(c.customerId);
                                setSelectedCustomerName(c.name);
                                setSelectedCustomerCode(c.accountCode);
                                setRememberSender(false);
                              }}
                              className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-1 text-xs text-slate-800 hover:bg-brand-50 hover:text-brand-700"
                            >
                              <span>{c.name}</span>
                              <span className="font-mono text-slate-400">({c.accountCode})</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Remember sender checkbox */}
                {selectedCustomerId && canReview && !isFinalized && o.email.from && (
                  <label className="mt-3 flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rememberSender}
                      onChange={(e) => setRememberSender(e.target.checked)}
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                    <span>
                      Remember sender <code className="font-mono">{o.email.from}</code> for this customer
                    </span>
                  </label>
                )}
              </Card>

              {/* Order Header Fields */}
              <Card title="Order Details">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <label className="block text-xs font-medium text-slate-500">PO Number</label>
                    <input
                      type="text"
                      disabled={!canReview || isFinalized}
                      value={poNumber}
                      onChange={(e) => setPoNumber(e.target.value)}
                      className="mt-0.5 block w-full rounded border border-slate-300 px-2 py-1 text-sm shadow-xs focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500">Order Date</label>
                    <input
                      type="date"
                      disabled={!canReview || isFinalized}
                      value={orderDate}
                      onChange={(e) => setOrderDate(e.target.value)}
                      className="mt-0.5 block w-full rounded border border-slate-300 px-2 py-1 text-sm shadow-xs focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500">Delivery Date</label>
                    <input
                      type="date"
                      disabled={!canReview || isFinalized}
                      value={requestedDeliveryDate}
                      onChange={(e) => setRequestedDeliveryDate(e.target.value)}
                      className="mt-0.5 block w-full rounded border border-slate-300 px-2 py-1 text-sm shadow-xs focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500">Currency</label>
                    <input
                      type="text"
                      maxLength={3}
                      disabled={!canReview || isFinalized}
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                      className="mt-0.5 block w-full rounded border border-slate-300 px-2 py-1 text-sm uppercase shadow-xs focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-slate-500">Delivery Address</label>
                    <div className="grid grid-cols-3 gap-1.5 mt-0.5">
                      <input
                        type="text"
                        placeholder="Street line 1"
                        disabled={!canReview || isFinalized}
                        value={line1}
                        onChange={(e) => setLine1(e.target.value)}
                        className="col-span-2 rounded border border-slate-300 px-2 py-1 text-xs shadow-xs focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50"
                      />
                      <input
                        type="text"
                        placeholder="Postcode"
                        disabled={!canReview || isFinalized}
                        value={postcode}
                        onChange={(e) => setPostcode(e.target.value)}
                        className="rounded border border-slate-300 px-2 py-1 text-xs shadow-xs focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:bg-slate-50"
                      />
                    </div>
                  </div>
                </div>
              </Card>
            </div>

            {/* Validation Issues Bar */}
            {o.issues.length > 0 && (
              <Card title="Checks &amp; Issues" className="bg-amber-50/20">
                <IssueList
                  issues={o.issues}
                  canReview={canReview && !isFinalized}
                  onDismiss={(issueId) => dismissIssueMutation.mutate(issueId)}
                />
              </Card>
            )}

            {/* Order Items Table - Clean, intuitive, non-technical design */}
            <Card
              title={
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-bold text-slate-900">Order Items ({lines.length})</span>
                    {lines.every((l) => l.match.sku) && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 border border-emerald-200">
                        <svg className="size-3 text-emerald-600" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
                        </svg>
                        All products matched
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {o.expectedValue !== null && o.expectedValue !== undefined && o.expectedValue !== o.value && (
                      <span className="text-xs text-slate-500 font-normal">
                        List value: {money(o.expectedValue, currency)}
                      </span>
                    )}
                    <span className="text-base font-bold text-slate-900 inline-flex items-center gap-1.5">
                      <span>Total: {money(o.value, currency)}</span>
                      {o.valueEstimated && (
                        <span
                          className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 border border-amber-200"
                          title="Estimated using catalogue list/contract prices for unpriced PO lines"
                        >
                          estimated
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              }
              description="Review matched products, quantities, and prices. Everything can be adjusted before pushing."
            >
              {lines.length === 0 ? (
                <p className="text-sm text-slate-500 py-6 text-center">No lines extracted from this document.</p>
              ) : (
                <div className="overflow-hidden">
                  <table className="w-full text-left text-sm table-auto">
                    <thead className="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold text-slate-500">
                      <tr>
                        <th className="px-3 py-2.5 w-10 text-center">#</th>
                        <th className="px-3 py-2.5">Product &amp; Match</th>
                        <th className="px-3 py-2.5 w-24 text-right">Qty</th>
                        <th className="px-3 py-2.5 w-24 text-right">Unit Price</th>
                        <th className="px-3 py-2.5 w-24 text-right">Total</th>
                        <th className="px-2 py-2.5 w-8 text-center" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {lines.map((l, index) => {
                        const lineIssues = o.issues.filter(
                          (i) => i.lineNo === l.lineNo && !i.resolved && i.severity !== 'info',
                        );
                        const isExpanded = expandedLineId === l.id;
                        const lineTotal =
                          l.quantity !== null && l.unitPrice !== null
                            ? l.quantity * l.unitPrice
                            : l.lineTotal;

                        return (
                          <>
                            <tr
                              key={l.id}
                              className={clsx(
                                'align-top transition-colors hover:bg-slate-50/60',
                                l.colour === 'red' && 'bg-red-50/40',
                                l.colour === 'amber' && 'bg-amber-50/30',
                                l.dirty && 'bg-brand-50/20',
                              )}
                            >
                              {/* # & Status Dot */}
                              <td className="px-3 py-3 text-center">
                                <div className="flex items-center justify-center gap-1.5 pt-0.5">
                                  <ColourDot colour={l.colour} />
                                  <span className="font-mono text-xs text-slate-400 font-medium">{l.lineNo}</span>
                                </div>
                              </td>

                              {/* Product & Match Details */}
                              <td className="px-3 py-3">
                                {l.match.sku ? (
                                  <div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="inline-flex items-center rounded-md bg-slate-900 px-2 py-0.5 font-mono text-xs font-bold text-white shadow-2xs">
                                        {l.match.sku}
                                      </span>
                                      <span className="text-sm font-semibold text-slate-900">
                                        {l.match.description || l.description}
                                      </span>
                                    </div>

                                    <div className="mt-1 flex items-center gap-2 flex-wrap text-xs">
                                      <Badge tone={l.colour === 'green' ? 'green' : 'amber'} dot>
                                        {l.match.method === 'manual' ? 'Manual Match' : 'Matched'}
                                      </Badge>
                                      {canReview && !isFinalized && (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setTargetLineId(l.id);
                                            setProductSearchTerm('');
                                            setProductSearchOpen(true);
                                          }}
                                          className="font-medium text-brand-600 hover:text-brand-800 hover:underline cursor-pointer"
                                        >
                                          Change Product
                                        </button>
                                      )}
                                      <span className="text-slate-300">•</span>
                                      <span className="text-slate-500">
                                        From order: <span className="font-medium text-slate-700 italic">"{l.description}"</span>
                                        {l.customerPartCode && (
                                          <span className="font-mono text-slate-500 ml-1">[{l.customerPartCode}]</span>
                                        )}
                                      </span>
                                    </div>
                                  </div>
                                ) : (
                                  <div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="text-sm font-bold text-rose-700">
                                        {l.description || 'Unidentified Item'}
                                      </span>
                                      <Badge tone="red" dot>Needs Product Match</Badge>
                                      {canReview && !isFinalized && (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setTargetLineId(l.id);
                                            setProductSearchTerm(l.description ?? '');
                                            setProductSearchOpen(true);
                                          }}
                                          className="rounded-md bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white shadow-xs hover:bg-brand-500 cursor-pointer"
                                        >
                                          Select Product
                                        </button>
                                      )}
                                    </div>

                                    {/* Candidate suggestions only if unmatched or low confidence */}
                                    {canReview && !isFinalized && l.match.candidates.length > 0 && (
                                      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                                        <span className="text-xs text-slate-400">Suggestions:</span>
                                        {l.match.candidates.slice(0, 3).map((c: MatchCandidateDto) => (
                                          <button
                                            key={c.productId}
                                            type="button"
                                            onClick={() =>
                                              applyProductToLine(l.id, {
                                                id: c.productId,
                                                sku: c.sku,
                                                description: c.description,
                                              })
                                            }
                                            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-700 font-medium hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700 shadow-2xs"
                                          >
                                            <span className="font-mono font-bold text-slate-900">{c.sku}</span>
                                            <span className="truncate max-w-40">{c.description}</span>
                                          </button>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )}

                                {/* Line issues if any */}
                                {lineIssues.map((p) => (
                                  <p key={p.id} className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900 border border-amber-200">
                                    <span>⚠️</span>
                                    <span>{p.message}</span>
                                  </p>
                                ))}
                              </td>

                              {/* Quantity */}
                              <td className="px-3 py-3 text-right">
                                <div className="flex flex-col items-end">
                                  <input
                                    type="number"
                                    min={0}
                                    step="any"
                                    disabled={!canReview || isFinalized}
                                    value={l.quantity ?? ''}
                                    onChange={(e) => {
                                      const val = e.target.value ? parseFloat(e.target.value) : null;
                                      setLines((prev) =>
                                        prev.map((item, i) =>
                                          i === index
                                            ? {
                                                ...item,
                                                quantity: val,
                                                convertedQuantity: val !== null ? val * item.conversionFactor : null,
                                                lineTotal:
                                                  val !== null && item.unitPrice !== null && item.unitPrice !== undefined
                                                    ? val * item.unitPrice
                                                    : item.lineTotal,
                                                dirty: true,
                                              }
                                            : item,
                                        ),
                                      );
                                    }}
                                    className="w-16 rounded-md border border-slate-200 px-2 py-1 text-right text-sm font-semibold text-slate-900 shadow-2xs hover:border-slate-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 disabled:border-transparent disabled:bg-transparent"
                                  />
                                  <span className="text-[11px] text-slate-400 mt-0.5">
                                    {l.unit || 'units'}
                                    {l.conversionFactor !== 1 && ` (x${l.conversionFactor})`}
                                  </span>
                                </div>
                              </td>

                              {/* Unit Price */}
                              <td className="px-3 py-3 text-right">
                                <div className="flex flex-col items-end">
                                  <div className="relative flex items-center">
                                    <span className="absolute left-2 text-xs text-slate-400 pointer-events-none">£</span>
                                    <input
                                      type="number"
                                      step="any"
                                      min={0}
                                      disabled={!canReview || isFinalized}
                                      value={l.unitPrice ?? ''}
                                      onChange={(e) => {
                                        const val = e.target.value ? parseFloat(e.target.value) : null;
                                        setLines((prev) =>
                                          prev.map((item, i) =>
                                            i === index
                                              ? {
                                                  ...item,
                                                  unitPrice: val,
                                                  lineTotal:
                                                    val !== null && item.quantity !== null && item.quantity !== undefined
                                                      ? val * item.quantity
                                                      : item.lineTotal,
                                                  dirty: true,
                                                }
                                              : item,
                                          ),
                                        );
                                      }}
                                      className="w-20 rounded-md border border-slate-200 pl-5 pr-2 py-1 text-right text-sm font-medium text-slate-900 shadow-2xs hover:border-slate-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 disabled:border-transparent disabled:bg-transparent"
                                    />
                                  </div>
                                  {l.expectedPrice !== null && l.expectedPrice !== undefined && l.expectedPrice !== l.unitPrice && (
                                    <span className="text-[10px] text-slate-400 mt-0.5" title="Catalogue list price">
                                      List: {money(l.expectedPrice, currency)}
                                    </span>
                                  )}
                                </div>
                              </td>

                              {/* Line Total */}
                              <td className="px-3 py-3 text-right">
                                <div className="flex flex-col items-end pt-1">
                                  <span className="text-sm font-bold text-slate-900">
                                    {money(lineTotal, currency)}
                                  </span>
                                </div>
                              </td>

                              {/* Details Toggle */}
                              <td className="px-2 py-3 text-center">
                                <button
                                  type="button"
                                  onClick={() => setExpandedLineId(isExpanded ? null : l.id)}
                                  className="rounded p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 cursor-pointer"
                                  title={isExpanded ? 'Hide details' : 'Edit part code or pack conversion'}
                                >
                                  <svg
                                    className={clsx('size-4 transition-transform', isExpanded && 'rotate-180')}
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                  >
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                  </svg>
                                </button>
                              </td>
                            </tr>

                            {/* Expandable Advanced Options Drawer */}
                            {isExpanded && (
                              <tr key={`${l.id}-expanded`} className="bg-slate-50/90 border-b border-slate-200">
                                <td colSpan={6} className="px-6 py-3">
                                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                                    <div>
                                      <label className="font-semibold text-slate-700 block">Customer Part Code</label>
                                      <input
                                        type="text"
                                        placeholder="e.g. CUST-REF-1"
                                        disabled={!canReview || isFinalized}
                                        value={l.customerPartCode ?? ''}
                                        onChange={(e) => {
                                          const val = e.target.value;
                                          setLines((prev) =>
                                            prev.map((item, i) =>
                                              i === index ? { ...item, customerPartCode: val, dirty: true } : item,
                                            ),
                                          );
                                        }}
                                        className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-mono text-slate-800"
                                      />
                                    </div>
                                    <div>
                                      <label className="font-semibold text-slate-700 block">Extracted PO Description</label>
                                      <input
                                        type="text"
                                        disabled={!canReview || isFinalized}
                                        value={l.description ?? ''}
                                        onChange={(e) => {
                                          const val = e.target.value;
                                          setLines((prev) =>
                                            prev.map((item, i) =>
                                              i === index ? { ...item, description: val, dirty: true } : item,
                                            ),
                                          );
                                        }}
                                        className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-800"
                                      />
                                    </div>
                                    <div>
                                      <label className="font-semibold text-slate-700 block">Pack Conversion Factor</label>
                                      <input
                                        type="number"
                                        step="any"
                                        min={0}
                                        disabled={!canReview || isFinalized}
                                        value={l.conversionFactor ?? 1}
                                        onChange={(e) => {
                                          const val = e.target.value ? parseFloat(e.target.value) : 1;
                                          setLines((prev) =>
                                            prev.map((item, i) =>
                                              i === index
                                                ? {
                                                    ...item,
                                                    conversionFactor: val,
                                                    convertedQuantity:
                                                      item.quantity !== null && item.quantity !== undefined
                                                        ? Math.round(item.quantity * val * 10000) / 10000
                                                        : null,
                                                    colour: val !== 1 ? 'amber' : item.colour,
                                                    dirty: true,
                                                  }
                                                : item,
                                            ),
                                          );
                                        }}
                                        className="mt-1 w-full rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-mono text-slate-800"
                                      />
                                      <p className="mt-0.5 text-[10px] text-slate-500">
                                        Converted total: <span className="font-semibold text-slate-700">{l.convertedQuantity ?? '-'}</span> units
                                      </p>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* Audit & Corrections History */}
            {corrections.data && corrections.data.length > 0 && (
              <Card title="Review &amp; Edit History">
                <ul className="divide-y divide-slate-100 text-xs">
                  {corrections.data.map((c) => (
                    <li key={c.id} className="py-2 flex items-center justify-between">
                      <div>
                        <span className="font-semibold text-slate-800">{c.userName || 'Reviewer'}</span>{' '}
                        <span>corrected </span>
                        <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-slate-700">
                          {c.field}
                        </code>
                        <span className="text-slate-500"> from </span>
                        <span className="text-red-700">{String(c.before ?? '(none)')}</span>
                        <span className="text-slate-500"> to </span>
                        <span className="font-medium text-emerald-700">{String(c.after ?? '(none)')}</span>
                      </div>
                      <span className="text-slate-400">{new Date(c.createdAt).toLocaleTimeString('en-GB')}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}
      </div>

      {/* Product Search Modal */}
      <Modal
        open={productSearchOpen}
        onClose={() => setProductSearchOpen(false)}
        title="Search Product Catalogue"
        maxWidth="max-w-xl"
      >
        <SearchInput
          placeholder="Search by SKU, description or barcode..."
          value={productSearchTerm}
          onChange={setProductSearchTerm}
          className="mb-4"
        />
        <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
          {productSearchResults.isPending && (
            <p className="text-center py-6 text-sm text-slate-500">Searching products...</p>
          )}
          {productSearchResults.data?.items.map((prod) => (
            <button
              key={prod.id}
              type="button"
              onClick={() => {
                if (targetLineId) {
                  applyProductToLine(targetLineId, prod);
                  setProductSearchOpen(false);
                }
              }}
              className="w-full text-left p-2.5 hover:bg-brand-50 rounded flex items-center justify-between transition-colors"
            >
              <div>
                <p className="font-mono text-xs font-bold text-slate-900">{prod.sku}</p>
                <p className="text-xs text-slate-700">{prod.description}</p>
                {prod.packSize && prod.packSize > 1 && (
                  <p className="text-[11px] text-slate-400">Pack size: {prod.packSize} {prod.uom}</p>
                )}
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs font-semibold text-slate-800">
                  {prod.defaultPrice !== null ? `£${prod.defaultPrice.toFixed(2)}` : '-'}
                </p>
                <span className="text-[11px] text-slate-400">
                  Stock: {prod.stockQty ?? 0}
                </span>
              </div>
            </button>
          ))}
          {productSearchResults.data?.items.length === 0 && (
            <p className="text-center py-6 text-sm text-slate-500">No products found for this search.</p>
          )}
        </div>
      </Modal>

      {/* Customer Search Modal */}
      <Modal
        open={customerSearchOpen}
        onClose={() => setCustomerSearchOpen(false)}
        title="Select Customer"
        maxWidth="max-w-lg"
      >
        <SearchInput
          placeholder="Search customers by name, account code or domain..."
          value={customerSearchTerm}
          onChange={setCustomerSearchTerm}
          className="mb-4"
        />
        <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
          {customerSearchResults.isPending && (
            <p className="text-center py-6 text-sm text-slate-500">Searching customers...</p>
          )}
          {customerSearchResults.data?.items.map((cust) => (
            <button
              key={cust.id}
              type="button"
              onClick={() => {
                setSelectedCustomerId(cust.id);
                setSelectedCustomerName(cust.name);
                setSelectedCustomerCode(cust.accountCode);
                setRememberSender(false);
                setCustomerSearchOpen(false);
                toast.success(`Customer selected: ${cust.name}`);
              }}
              className="w-full text-left p-2.5 hover:bg-brand-50 rounded flex items-center justify-between transition-colors"
            >
              <div>
                <p className="text-sm font-semibold text-slate-900">{cust.name}</p>
                <p className="font-mono text-xs text-slate-500">Account: {cust.accountCode}</p>
                {cust.emailDomains.length > 0 && (
                  <p className="text-[11px] text-slate-400">@{cust.emailDomains.join(', @')}</p>
                )}
              </div>
              {cust.creditHold && <Badge tone="red">Credit Hold</Badge>}
            </button>
          ))}
          {customerSearchResults.data?.items.length === 0 && (
            <p className="text-center py-6 text-sm text-slate-500">No customers found.</p>
          )}
        </div>
      </Modal>

      {/* Rejection Reason Modal */}
      <Modal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title="Reject Order"
        maxWidth="max-w-md"
      >
        <p className="text-sm text-slate-600 mb-3">
          Please provide a reason for rejecting this purchase order. This will be recorded in the audit log.
        </p>
        <textarea
          rows={3}
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder="e.g. Duplicate order, credit hold, or unresolvable part numbers..."
          className="w-full rounded border border-slate-300 p-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setRejectOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!rejectReason.trim()}
            loading={rejectMutation.isPending}
            onClick={() => rejectMutation.mutate(rejectReason.trim())}
          >
            Confirm Rejection
          </Button>
        </div>
      </Modal>

      {/* Customer Email Drawer / Modal */}
      <Modal
        open={emailModalOpen}
        onClose={() => setEmailModalOpen(false)}
        title="Customer Emails & Clarification"
        maxWidth="max-w-4xl"
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-1 border-r border-slate-200 pr-4 space-y-4">
            <div className="flex flex-col gap-2">
              <Button
                variant="secondary"
                className="w-full text-xs"
                loading={draftMutation.isPending}
                onClick={() => draftMutation.mutate('clarification')}
              >
                + Draft Clarification
              </Button>
              <Button
                variant="secondary"
                className="w-full text-xs"
                loading={draftMutation.isPending}
                onClick={() => draftMutation.mutate('acknowledgment')}
              >
                + Draft Acknowledgment
              </Button>
            </div>

            <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 pt-2 border-t border-slate-100">
              History / Drafts ({outboundEmails.data?.length ?? 0})
            </div>
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {outboundEmails.data?.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setActiveEmailId(m.id);
                    setEmailTo(m.to);
                    setEmailSubject(m.subject);
                    setEmailBody(m.body);
                  }}
                  className={clsx(
                    'w-full text-left p-2.5 rounded-lg text-xs transition-colors border',
                    activeEmailId === m.id
                      ? 'bg-brand-50 border-brand-300 ring-1 ring-brand-300'
                      : 'hover:bg-slate-50 border-slate-200',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold capitalize text-slate-800">{m.type}</span>
                    <Badge tone={m.status === 'sent' ? 'green' : 'amber'}>{m.status}</Badge>
                  </div>
                  <p className="text-[11px] text-slate-600 truncate mt-1 font-medium">{m.subject}</p>
                  <p className="text-[10px] text-slate-400 mt-1">
                    {m.status === 'sent' && m.sentAt
                      ? `Sent ${new Date(m.sentAt).toLocaleDateString()}`
                      : `Created ${new Date(m.createdAt).toLocaleDateString()}`}
                  </p>
                </button>
              ))}
              {(!outboundEmails.data || outboundEmails.data.length === 0) && (
                <p className="text-xs text-slate-400 italic py-3 text-center">No emails yet.</p>
              )}
            </div>
          </div>

          <div className="md:col-span-2 space-y-3">
            {activeEmailId ? (
              (() => {
                const current = outboundEmails.data?.find((x) => x.id === activeEmailId);
                const isSent = current?.status === 'sent';
                return (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">
                        {isSent ? 'Sent Email' : 'Edit Email Draft'}
                      </span>
                      {isSent && current?.sentAt && (
                        <span className="text-xs text-slate-500">
                          Sent: {new Date(current.sentAt).toLocaleString()}
                        </span>
                      )}
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">To</label>
                      <input
                        type="email"
                        disabled={isSent}
                        value={emailTo}
                        onChange={(e) => setEmailTo(e.target.value)}
                        className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:bg-slate-100"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Subject</label>
                      <input
                        type="text"
                        disabled={isSent}
                        value={emailSubject}
                        onChange={(e) => setEmailSubject(e.target.value)}
                        className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:bg-slate-100"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Body</label>
                      <textarea
                        rows={11}
                        disabled={isSent}
                        value={emailBody}
                        onChange={(e) => setEmailBody(e.target.value)}
                        className="w-full font-mono text-xs rounded border border-slate-300 p-2.5 leading-relaxed focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:bg-slate-100"
                      />
                    </div>
                    {!isSent && (
                      <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                        <Button
                          variant="secondary"
                          loading={saveEmailMutation.isPending}
                          onClick={() => saveEmailMutation.mutate(activeEmailId)}
                        >
                          Save Draft
                        </Button>
                        <Button
                          variant="primary"
                          loading={sendEmailMutation.isPending}
                          onClick={() => sendEmailMutation.mutate(activeEmailId)}
                        >
                          Send Email
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })()
            ) : (
              <div className="flex flex-col items-center justify-center h-72 text-center text-slate-500 border border-dashed border-slate-200 rounded-lg p-6">
                <p className="text-sm font-semibold text-slate-700">Select an email or generate a new draft</p>
                <p className="text-xs text-slate-400 mt-2 max-w-sm">
                  Click "+ Draft Clarification" to draft an email asking the customer to clarify flagged issues, or "+ Draft Acknowledgment" to confirm accepted lines.
                </p>
              </div>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}
